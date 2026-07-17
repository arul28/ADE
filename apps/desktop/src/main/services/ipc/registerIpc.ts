import { app, BrowserWindow, clipboard, desktopCapturer, dialog, ipcMain, nativeImage, shell, systemPreferences } from "electron";
import type { IpcMainInvokeEvent } from "electron";
import { compareUpdateVersions, createEmptyAutoUpdateSnapshot, type createAutoUpdateService } from "../updates/autoUpdateService";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import type { Server as NetServer } from "node:net";
import type { DiskPressureMonitor, DiskPressureSnapshot } from "../storage/diskPressure";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { IPC } from "../../../shared/ipc";
import { isSyncServiceUnavailableError } from "../../../shared/runtimeErrors";
import { encodeCodedErrorMessage, parseCodedErrorMessage } from "../../../shared/codedError";
import { areAutomationsEnabledForPackagedState } from "../../../shared/automationAvailability";
import { findRecentProjectForRepo } from "../projects/repoProjectResolver";
import { getModelById } from "../../../shared/modelRegistry";
import { appendEvent as perfAppend, isRunActive as isPerfRunActive } from "../perf/perfLog";
import { buildPrAiResolutionContextKey, isAdeUsageRangePreset, isAdeUsageScope } from "../../../shared/types";
import { detectCliAuthStatuses } from "../ai/authDetector";
import { resolveClaudeCodeExecutable } from "../ai/claudeCodeExecutable";
import { buildProviderConnections } from "../ai/providerConnectionStatus";
import { browseProjectDirectories } from "../projects/projectBrowserService";
import { getProjectDetail } from "../projects/projectDetailService";
import {
  inspectProjectPathCached,
  invalidateProjectPathInspectionCache,
} from "../projects/projectPathInspector";
import { deleteTerminalSessionWithRuntimeCleanup } from "../sessions/deleteTerminalSession";
import {
  removeProjectIconOverride,
  resolveProjectIcon,
  resolveProjectIconPath,
  setProjectIconOverrideFromSelection,
} from "../projects/projectIconResolver";
import { launchAgentChatCli } from "../chat/agentChatCliLaunch";
import { isMeaningfulUsageAction, recordUsageInteraction, usageActionFromIpcChannel } from "../usage/usageStatsStore";
import {
  parseProductAnalyticsCapture,
  type ProductAnalyticsStatus,
} from "../../../shared/types/productAnalytics";
import type { ProductAnalyticsService } from "../analytics/productAnalyticsService";
import type { createProjectSecretService } from "../secrets/projectSecretService";
import { PROJECT_SECRET_ENV_MAX_BYTES } from "../secrets/projectSecretEnv";
import { runGit } from "../git/git";
import type {
  AdeCleanupResult,
  AdeProjectSnapshot,
  IosSimulatorDevice,
  IosSimulatorSession,
  IosSimulatorStatus,
  IosSimulatorToolStatus,
  IosSimulatorWindowState,
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
} from "../../../shared/types";
import { toShallowRecentProjectSummary } from "../projects/recentProjectSummary";
import type {
  ApplyConflictProposalArgs,
  BatchAssessmentResult,
  AttachLaneArgs,
  AdoptAttachedLaneArgs,
  UnregisteredLaneCandidate,
  AppInfo,
  AppWelcomeVideoState,
  AppResourceUsageSnapshot,
  LatestReleaseInfo,
  ClearLocalAdeDataArgs,
  ClearLocalAdeDataResult,
  ArchiveLaneArgs,
  AutomationIngressEventRecord,
  AutomationIngressStatus,
  AutomationScheduledCleanup,
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
  ReviewLaunchContext,
  BuiltInBrowserClaimArgs,
  AppControlClickArgs,
  AppControlConnectArgs,
  AppControlCoordinateSpace,
  AppControlInspectPointArgs,
  AppControlLaunchArgs,
  AppControlSnapshotArgs,
  AppControlStopArgs,
  AppControlTypeTextArgs,
  BuiltInBrowserAttachWebviewArgs,
  BuiltInBrowserBoundsArgs,
  BuiltInBrowserClearPermissionsArgs,
  BuiltInBrowserCreateTabArgs,
  BuiltInBrowserNavigateArgs,
  BuiltInBrowserOpenPanelArgs,
  BuiltInBrowserProjectScopeArgs,
  BuiltInBrowserSelectPointArgs,
  BuiltInBrowserTabArgs,
  BuiltInBrowserTabTargetArgs,
  ReviewListRunsArgs,
  ReviewRun,
  ReviewRunDetail,
  ReviewStartRunArgs,
  AdeActionRegistryEntry,
  ConflictProposal,
  ConflictExternalResolverRunSummary,
  ConflictProposalPreview,
  ConflictOverlap,
  ConflictStatus,
  DraftPrDescriptionArgs,
  CreateLaneArgs,
  CreateChildLaneArgs,
  CreateLaneFromUnstagedArgs,
  LaneBranchSwitchArgs,
  LaneBranchSwitchPreview,
  LaneBranchSwitchResult,
  DeleteLaneArgs,
  DockLayout,
  GraphPersistedState,
  FileChangeEvent,
  FileContent,
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
  GitActionResult,
  GitCherryPickArgs,
  GitCommitArgs,
  GitCreateTagArgs,
  GitGenerateCommitMessageArgs,
  GitGenerateCommitMessageResult,
  GitCommitSummary,
  GitConflictState,
  GitGetCommitMessageArgs,
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
  GitUpstreamSyncStatus,
  GitRevertArgs,
  GitStashPushArgs,
  GitStashRefArgs,
  GitStashSummary,
  GitSyncArgs,
  GitHubAppDeviceAuthPollResult,
  GitHubAppDeviceAuthStartResult,
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
  CreateLaneFromPrBranchArgs,
  CreateLaneFromPrBranchPreflightResult,
  CreateLaneFromPrBranchResult,
  CreatePrFromLaneArgs,
  CreateIntegrationPrArgs,
  CreateIntegrationPrResult,
  CreateQueuePrsArgs,
  CreateQueuePrsResult,
  ReorderQueuePrsArgs,
  CommitIntegrationArgs,
  CleanupIntegrationWorkflowArgs,
  CleanupIntegrationWorkflowResult,
  DeleteIntegrationProposalArgs,
  DeleteIntegrationProposalResult,
  DeletePrArgs,
  DeletePrResult,
  DismissIntegrationCleanupArgs,
  GitHubPrSnapshot,
  IntegrationProposal,
  IntegrationResolutionState,
  ListIntegrationWorkflowsArgs,
  CreateIntegrationLaneForProposalArgs,
  CreateIntegrationLaneForProposalResult,
  StartIntegrationResolutionArgs,
  StartIntegrationResolutionResult,
  RecheckIntegrationStepArgs,
  RecheckIntegrationStepResult,
  PrAiResolutionInputArgs,
  PrAiResolutionGetSessionArgs,
  PrAiResolutionGetSessionResult,
  PrAiResolutionStartArgs,
  PrAiResolutionStartResult,
  PrAiResolutionStopArgs,
  PrAiResolutionEventPayload,
  PrAiResolutionContext,
  PrAiResolutionSessionInfo,
  PrAiResolutionSessionStatus,
  PrAgentPermissionMode,
  LinkPrToLaneArgs,
  LandResult,
  LandStackEnhancedArgs,
  LandQueueNextArgs,
  CleanupPrBranchArgs,
  CleanupPrBranchResult,
  PrCheck,
  PrCommit,
  PrComment,
  PrGithubCoords,
  PrReviewThread,
  PrHealth,
  PrMergeContext,
  PrReview,
  PrStatus,
  PrSummary,
  QueueLandingState,
  ReplyToPrReviewThreadArgs,
  ResolvePrReviewThreadArgs,
  PostPrReviewCommentArgs,
  SetPrReviewThreadResolvedArgs,
  ReactToPrCommentArgs,
  SimulateIntegrationArgs,
  UpdatePrDescriptionArgs,
  LandPrArgs,
  UpdateBranchArgs,
  UpdateBranchResult,
  LandStackArgs,
  GetLaneConflictStatusArgs,
  GetDiffChangesArgs,
  GetFileDiffArgs,
  GetFilePatchArgs,
  GetProcessLogTailArgs,
  GetTestLogTailArgs,
  ExportHistoryArgs,
  ExportHistoryResult,
  AgentChatApproveArgs,
  AgentChatArchiveArgs,
  AgentChatCodexClearGoalArgs,
  AgentChatCodexGetGoalArgs,
  AgentChatCodexSetGoalArgs,
  AgentChatCodexSetGoalStatusArgs,
  CodexThreadGoal,
  AgentChatClaudeSessionInfo,
  AgentChatClaudeSessionInfoArgs,
  AgentChatClaudeSessionListArgs,
  AgentChatClaudeSessionMessage,
  AgentChatClaudeSessionMessagesArgs,
  AgentChatMainTranscriptArgs,
  AgentChatSubagentTranscriptArgs,
  AgentChatSubagentTranscriptMessage,
  AgentChatClaudeOutputStyle,
  AgentChatClaudeOutputStylesArgs,
  AgentChatClaudePlugin,
  AgentChatClaudePluginsArgs,
  AgentChatReloadClaudePluginsArgs,
  AgentChatReloadClaudePluginsResult,
  AgentChatClaudePermissionMode,
  AgentChatCreateArgs,
  AgentChatLaunchArgs,
  AgentChatLaunchCliArgs,
  AgentChatLaunchCliResult,
  AgentChatDeleteArgs,
  AgentChatGetSummaryArgs,
  AgentChatEventHistoryPage,
  AgentChatEventHistorySnapshot,
  AgentChatHandoffArgs,
  AgentChatHandoffResult,
  AgentChatMarkCrossMachineHandoffArgs,
  AgentChatPrepareCrossMachineHandoffArgs,
  AgentChatPrepareCrossMachineHandoffResult,
  AgentChatValidateCrossMachineSourceArgs,
  AgentChatInterruptArgs,
  AgentChatRecoverCodexTurnArgs,
  AgentChatRecoverCodexTurnResult,
  AgentChatRecoverContinuityArgs,
  AgentChatContinuityRecoveryResult,
  AgentChatListArgs,
  AgentChatModelInfo,
  AgentChatModelsArgs,
  AgentChatParallelLaunchState,
  AgentChatParallelLaunchStateArgs,
  AgentChatPermissionMode,
  AgentChatRespondToInputArgs,
  AgentChatSendArgs,
  AgentChatSetParallelLaunchStateArgs,
  AgentChatSuggestLaneNameArgs,
  AgentChatSession,
  AgentChatSessionSummary,
  AgentChatSubagentSnapshot,
  AgentChatSubagentListArgs,
  AgentChatKillDroidWorkerArgs,
  AgentChatSessionCapabilities,
  AgentChatSessionCapabilitiesArgs,
  AgentChatSteerArgs,
  AgentChatSteerResult,
  AgentChatCancelSteerArgs,
  AgentChatEditSteerArgs,
  AgentChatDispatchSteerArgs,
  AgentChatDispatchSteerResult,
  AgentChatCancelDispatchedSteerArgs,
  AgentChatCancelDispatchedSteerResult,
  AgentChatOpenCodePermissionMode,
  AgentChatUpdateSessionArgs,
  AgentChatSetScheduledWorkPausedArgs,
  AgentChatSetScheduledWorkPausedResult,
  AgentChatCreateScheduledWorkArgs,
  AgentChatCreateScheduledWorkResult,
  AgentChatListScheduledWorkArgs,
  AgentChatScheduledWorkItem,
  AgentChatCancelScheduledWorkArgs,
  AgentChatCancelScheduledWorkResult,
  AgentChatSetClaudeOutputStyleArgs,
  AgentChatSlashCommand,
  AgentChatSlashCommandsArgs,
  AgentChatContextUsage,
  AgentChatContextUsageArgs,
  AgentChatRewindFilesArgs,
  AgentChatRewindFilesResult,
  AgentChatFileSearchArgs,
  AgentChatFileSearchResult,
  AgentChatGetTurnFileDiffArgs,
  AgentTool,
  KeybindingOverride,
  KeybindingsSnapshot,
  ImportBranchLaneArgs,
  OnboardingDetectionResult,
  OnboardingExistingLaneCandidate,
  OnboardingHelpState,
  OnboardingStatus,
  LaneLinearIssue,
  LaneListSnapshot,
  LaneSummary,
  ListOperationsArgs,
  ListOverlapsArgs,
  ListLanesArgs,
  ListSessionsArgs,
  DeleteSessionArgs,
  ListTestRunsArgs,
  MergeSimulationArgs,
  MergeSimulationResult,
  OperationRecord,
  ProcessActionArgs,
  ProcessDefinition,
  ProcessRuntime,
  ProcessGroupArgs,
  ProcessStackArgs,
  ProjectConfigCandidate,
  ProjectConfigDiff,
  ProjectConfigSnapshot,
  ProjectConfigTrust,
  ProjectConfigValidationResult,
  ProjectBrowseInput,
  ProjectBrowseResult,
  ProjectDetail,
  ProjectPathInspection,
  ProjectIcon,
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
  ChatTerminalActiveForChatArgs,
  ChatTerminalListArgs,
  ChatTerminalPreviewArgs,
  ChatTerminalReadArgs,
  ChatTerminalReattachArgs,
  ChatTerminalSignalArgs,
  ChatTerminalWriteArgs,
  ReparentLaneArgs,
  ReparentLaneResult,
  RenameLaneArgs,
  RebaseAbortArgs,
  RebasePushArgs,
  RebaseRollbackArgs,
  RebaseRun,
  RebaseStartArgs,
  RebaseStartResult,
  RebaseSuggestion,
  AutoRebaseLaneStatus,
  RiskMatrixEntry,
  PrepareConflictProposalArgs,
  RequestConflictProposalArgs,
  RunExternalConflictResolverArgs,
  ListExternalConflictResolverRunsArgs,
  CommitExternalConflictResolverRunArgs,
  CommitExternalConflictResolverRunResult,
  AttachResolverSessionArgs,
  RunConflictPredictionArgs,
  UndoConflictProposalArgs,
  CancelResolverSessionArgs,
  RunTestSuiteArgs,
  SessionDeltaSummary,
  SessionLinearIssueLink,
  StackChainItem,
  StopTestRunArgs,
  TerminalSessionDetail,
  TerminalSessionSummary,
  UpdateSessionMetaArgs,
  TestRunSummary,
  TestSuiteDefinition,
  UpdateIntegrationProposalArgs,
  UpdateLaneAppearanceArgs,
  WriteTextAtomicArgs,
  AiClaudeAvailability,
  AiDetectedAuth,
  AiFeatureKey,
  AiProviderConnections,
  AiApiKeyVerificationResult,
  AiConfig,
  AiSettingsStatus,
  OpenCodeRuntimeSnapshot,
  SyncDesktopConnectionDraft,
  SyncCloudRelayStatus,
  SyncDeviceRecord,
  SyncDeviceRuntimeState,
  SyncGetStatusArgs,
  SyncPeerDeviceType,
  SyncRoleSnapshot,
  SyncTransferReadiness,
  CtoGetStateArgs,
  CtoEnsureSessionArgs,
  CtoUpdateIdentityArgs,
  CtoListSessionLogsArgs,
  CtoSnapshot,
  CtoSessionLogEntry,
  CtoGetMemoryArgs,
  CtoUpdateMemoryArgs,
  CtoSearchMemoryArgs,
  CtoMemorySnapshot,
  CtoSearchMemoryResult,
  CtoGetLinearOAuthSessionArgs,
  CtoGetLinearOAuthSessionResult,
  CtoGetLinearIssuePickerDataResult,
  CtoLinearIssueComment,
  CtoLinearQuickView,
  CtoSearchLinearIssuesArgs,
  CtoSearchLinearIssuesResult,
  CtoRunProjectScanResult,
  CtoStartLinearOAuthResult,
  LinearConnectionStatus,
  CtoSetLinearTokenArgs,
  CtoSetLinearOAuthClientArgs,
  AdeUsageStats,
  GetAdeUsageStatsArgs,
  UsageSnapshot,
  BudgetCheckResult,
  BudgetCheckArgs,
  BudgetCapScope,
  BudgetCapProvider,
  BudgetCapConfig,
  ComputerUseArtifactListArgs,
  ComputerUseArtifactReviewArgs,
  ComputerUseArtifactRouteArgs,
  ComputerUseArtifactView,
  ComputerUseOwnerSnapshot,
  ComputerUseOwnerSnapshotArgs,
  LaneEnvInitConfig,
  LaneOverlayOverrides,
  LaneTemplate,
  PortLease,
  UpdateOAuthRedirectConfigArgs,
  GenerateRedirectUrisArgs,
  EncodeOAuthStateArgs,
  DecodeOAuthStateArgs,
  FeedbackPrepareDraftArgs,
  FeedbackPreparedDraft,
  FeedbackSubmission,
  FeedbackSubmitDraftArgs,
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
  CursorCloudStreamRunResult,
  UpdateInstallImpact,
  ExternalSessionListArgs,
  ExternalSessionImportArgs,
  ExternalSessionImportResult,
  ExternalSessionSummary,
} from "../../../shared/types";
import type { Logger } from "../logging/logger";
import type { AdeDb } from "../state/kvDb";
import type { createLaneService } from "../lanes/laneService";
import type { createLaneEnvironmentService } from "../lanes/laneEnvironmentService";
import type { createLaneTemplateService } from "../lanes/laneTemplateService";
import type { createPortAllocationService } from "../lanes/portAllocationService";
import type { createLaneProxyService } from "../lanes/laneProxyService";
import type { createOAuthRedirectService } from "../lanes/oauthRedirectService";
import type { createRuntimeDiagnosticsService } from "../lanes/runtimeDiagnosticsService";
import type { createRebaseSuggestionService } from "../lanes/rebaseSuggestionService";
import type { createAutoRebaseService } from "../lanes/autoRebaseService";
import type { LaneWorktreeLockService } from "../lanes/laneWorktreeLockService";
import type { createSessionService } from "../sessions/sessionService";
import type { SessionDeltaService } from "../sessions/sessionDeltaService";
import type { createPtyService } from "../pty/ptyService";
import {
  computeAppResourceUsageSnapshot,
  createProcessMetricRowsCollector,
} from "../pty/resourceUsageSampling";
import type {
  AppResourceUsageAttributionSources,
  ProcessMetricRowsCollector,
  ResourceAttributionRoot,
} from "../pty/resourceUsageSampling";
import {
  type createDiffService,
  MAX_DIFF_SIDE_TEXT_BYTES,
  appendDiffTruncationNotice,
} from "../diffs/diffService";
import type { createFileService } from "../files/fileService";
import { mergeAiConfig, type createProjectConfigService } from "../config/projectConfigService";
import type { createProcessService } from "../processes/processService";
import type { createTestService } from "../tests/testService";
import type { createGitOperationsService } from "../git/gitOperationsService";
import type { createOperationService } from "../history/operationService";
import type { createConflictService } from "../conflicts/conflictService";
import type { createJobEngine } from "../jobs/jobEngine";
import {
  type createTranscriptionService,
  type TranscriptionResult,
  type TranscriptionStatus,
  TranscriptionError,
} from "../transcription/transcriptionService";
import type { createAiIntegrationService } from "../ai/aiIntegrationService";
import { fetchAdeLatestRelease, type createGithubService } from "../github/githubService";
import { createAccountBridge } from "../account/accountBridge";
import type { createPrService } from "../prs/prService";
import type { createPrPollingService } from "../prs/prPollingService";
import type { createQueueLandingService } from "../prs/queueLandingService";
import type { createPrSummaryService } from "../prs/prSummaryService";
import type { createReviewService } from "../review/reviewService";
import type { createSearchService } from "../search/searchService";
import type { createExternalSessionsService } from "../externalSessions/externalSessionsService";
import type { createAgentChatService } from "../chat/agentChatService";
import type { createComputerUseArtifactBrokerService } from "../computerUse/computerUseArtifactBrokerService";
import { buildComputerUseOwnerSnapshot } from "../computerUse/controlPlane";
import type { createIosSimulatorService } from "../ios/iosSimulatorService";
import type { createAppControlService } from "../appControl/appControlService";
import type { createBuiltInBrowserService } from "../builtInBrowser/builtInBrowserService";
import { ipcInvokeTimeoutMs } from "./ipcTimeouts";
import { readGlobalState, writeGlobalState, reorderRecentProjects, setRecentProjectPinned, recentProjectKey } from "../state/globalState";
import type { RecentProject } from "../state/globalState";
import type { createKeybindingsService } from "../keybindings/keybindingsService";
import type { createAgentToolsService } from "../agentTools/agentToolsService";
import type { createDevToolsService } from "../devTools/devToolsService";
import type { createOnboardingService } from "../onboarding/onboardingService";
import type { DevToolsCheckResult } from "../../../shared/types/devTools";
import type { createAutomationService } from "../automations/automationService";
import type { createAutomationPlannerService } from "../automations/automationPlannerService";
import type { createAutomationIngressService } from "../automations/automationIngressService";
import type { LinearIngressService, LinearIngressStatus } from "../automations/linearIngressService";
import type { createGithubPollingService } from "../automations/githubPollingService";
import { ADE_ACTION_ALLOWLIST, getAdeActionDomainServices, listAllowedAdeActionNames } from "../adeActions/registry";
import type { AdeRuntime } from "../../../../../ade-cli/src/bootstrap";
import { ADE_WELCOME_VIDEO_ID, ADE_WELCOME_VIDEO_VERSION } from "../../../shared/welcomeVideo";

import type { createOrchestrationService } from "../orchestration/orchestrationService";
import { createOrchestrationDomainService } from "../orchestration/orchestrationDomain";
import type {
  ManifestSection,
  OrchestrationAgentInjectRequest,
  OrchestrationAssetRegisterRequest,
  OrchestrationClaimTaskRequest,
  OrchestrationManifestPatchRequest,
  OrchestrationPlanAppendRequest,
  OrchestrationPlanWriteRequest,
  OrchestrationReleaseTaskRequest,
  OrchestrationRunCreateRequest,
  OrchestrationSpawnAgentRequest,
} from "../../../shared/types/orchestration";
import type { createCtoStateService } from "../cto/ctoStateService";
import type { CtoMemoryService } from "../cto/ctoMemoryService";
import type { createLinearCredentialService } from "../cto/linearCredentialService";
import { createLinearOAuthService, type LinearOAuthService } from "../cto/linearOAuthService";
import type { LocalRuntimeConnectionPool } from "../localRuntime/localRuntimeConnectionPool";
import { createProjectRecoveryService } from "../runtime/projectRecoveryService";
import type { ProjectRecoveryDiagnosis, ProjectRepairReport } from "../../../shared/types/recovery";
import { registerRuntimeBridge } from "./runtimeBridge";
import type { createLinearIssueTracker } from "../cto/linearIssueTracker";
import type { createUsageTrackingService } from "../usage/usageTrackingService";
import type { createStorageInsightsService } from "../storage/storageInsightsService";
import type {
  StorageCleanupPreview,
  StorageCleanupResult,
  StorageCleanupTarget,
  StorageCompressionResult,
  StorageSnapshot,
} from "../../../shared/types/storage";
import type { createBudgetCapService } from "../usage/budgetCapService";
import type { createSyncHostService } from "../sync/syncHostService";
import type { createSyncService } from "../sync/syncService";
import {
  buildLaneListSnapshots,
  buildLanePresenceByLaneId,
  decorateLaneSummariesWithPresence,
} from "../lanes/laneListSnapshotService";
import type { createFeedbackReporterService } from "../feedback/feedbackReporterService";
import type { AdeProjectService } from "../projects/adeProjectService";
import type { ConfigReloadService } from "../projects/configReloadService";
import type { createProjectScaffoldService } from "../projects/projectScaffoldService";
import type { createAdeCliService } from "../cli/adeCliService";
import { getErrorMessage, isRecord, nowIso, resolvePathWithinRoot } from "../shared/utils";
import { quoteWindowsCmdArg } from "../shared/processExecution";
import { sanitizeResumeTargetId } from "../../utils/terminalSessionSignals";
import { probeLocalhostPort } from "../probeLocalhostPort";
import type { ProcessRegistryService } from "../runtime/processRegistryService";
import { openExternalUrl } from "../shared/externalLinks";

const APP_RESOURCE_USAGE_CACHE_MS = 900;
let appResourceUsageCache: {
  contexts: AppResourceUsageContext[];
  localRuntimeConnectionPool?: LocalRuntimeConnectionPool | null;
  sampledAtMs: number;
  snapshot: AppResourceUsageSnapshot;
} | null = null;
let appResourceUsageInFlight: {
  contexts: AppResourceUsageContext[];
  localRuntimeConnectionPool?: LocalRuntimeConnectionPool | null;
  promise: Promise<AppResourceUsageSnapshot>;
} | null = null;
let appProcessMetricRowsCollector: ProcessMetricRowsCollector | null = null;

function getAppProcessMetricRowsCollector(): ProcessMetricRowsCollector {
  if (!appProcessMetricRowsCollector) {
    const collector = createProcessMetricRowsCollector();
    appProcessMetricRowsCollector = collector;
    app.once("will-quit", () => collector.dispose());
  }
  return appProcessMetricRowsCollector;
}

type AppResourceUsageContext = Pick<AppContext, "processRegistry" | "ptyService" | "sessionService">;

function collectRuntimeOwnedPtyRoots(
  sessionService?: ReturnType<typeof createSessionService> | null,
  processRegistry?: ProcessRegistryService | null,
): { activePtyCount: number; ownerPids: number[] } {
  const isLiveSessionOwner = (session: {
    ownerPid?: number | null;
    ownerProcessStartedAt?: string | null;
  }): boolean => {
    if (!processRegistry) return false;
    if (session.ownerPid == null || session.ownerPid === process.pid) return false;
    const startedAt = typeof session.ownerProcessStartedAt === "string"
      ? session.ownerProcessStartedAt.trim()
      : "";
    return startedAt
      ? processRegistry.isProcessIdentityLive(session.ownerPid, startedAt)
      : processRegistry.isPidLive(session.ownerPid);
  };
  const runningSessions = sessionService
    ? sessionService
      .list({ status: "running", limit: null })
      .filter(isLiveSessionOwner)
    : [];
  return {
    activePtyCount: runningSessions.length,
    ownerPids: runningSessions
      .map((session) => session.ownerPid)
      .filter((pid): pid is number => typeof pid === "number" && Number.isFinite(pid) && pid > 0 && pid !== process.pid),
  };
}

function getSystemMemoryMB(): { freeMemoryMB: number | null; totalMemoryMB: number | null } {
  const electronProcess = process as NodeJS.Process & {
    getSystemMemoryInfo?: () => { free?: number; total?: number };
  };
  const read = electronProcess.getSystemMemoryInfo;
  if (typeof read !== "function") {
    return { freeMemoryMB: null, totalMemoryMB: null };
  }
  try {
    const info = read();
    const round = (value: number): number | null => (
      Number.isFinite(value) ? Math.round(value) : null
    );
    return {
      freeMemoryMB: round((info.free ?? 0) / 1024),
      totalMemoryMB: round((info.total ?? 0) / 1024),
    };
  } catch {
    return { freeMemoryMB: null, totalMemoryMB: null };
  }
}

function collectAppResourceAttributionSources(
  contexts: AppResourceUsageContext[],
  localRuntimeConnectionPool?: LocalRuntimeConnectionPool | null,
): AppResourceUsageAttributionSources {
  let activePtyCount = 0;
  const desktopPtyRoots: ResourceAttributionRoot[] = [];
  const adePtyHostPids = new Set<number>();
  for (const ctx of contexts) {
    const attribution = ctx.ptyService?.getResourceAttribution?.();
    if (attribution) {
      activePtyCount += attribution.activePtyCount;
      desktopPtyRoots.push(...attribution.roots);
    }
    const runtimeOwned = collectRuntimeOwnedPtyRoots(ctx.sessionService, ctx.processRegistry);
    activePtyCount += runtimeOwned.activePtyCount;
    for (const pid of runtimeOwned.ownerPids) adePtyHostPids.add(pid);
  }
  const adeRuntimePids = new Set<number>();
  for (const pid of localRuntimeConnectionPool?.getRuntimeProcessIds?.() ?? []) {
    if (typeof pid === "number" && Number.isFinite(pid) && pid > 0 && pid !== process.pid) {
      adeRuntimePids.add(pid);
      adePtyHostPids.delete(pid);
    }
  }
  return {
    adeRuntimePids: Array.from(adeRuntimePids),
    adePtyHostPids: Array.from(adePtyHostPids),
    desktopPtyRoots,
    activePtyCount,
  };
}

function sameAppResourceUsageContexts(
  first: AppResourceUsageContext[],
  second: AppResourceUsageContext[],
): boolean {
  return first.length === second.length && first.every((ctx, index) => ctx === second[index]);
}

// One in-flight sample serves every caller (all windows/projects); the newest
// completed snapshot is cached and republished until it goes stale. A slow or
// failed `ps` never blocks Electron main — collection is fully asynchronous.
function getCachedAppResourceUsageSnapshot(
  contexts: AppResourceUsageContext[],
  localRuntimeConnectionPool?: LocalRuntimeConnectionPool | null,
): Promise<AppResourceUsageSnapshot> {
  const now = Date.now();
  if (
    appResourceUsageCache
    && sameAppResourceUsageContexts(appResourceUsageCache.contexts, contexts)
    && appResourceUsageCache.localRuntimeConnectionPool === localRuntimeConnectionPool
    && now - appResourceUsageCache.sampledAtMs < APP_RESOURCE_USAGE_CACHE_MS
  ) {
    return Promise.resolve(appResourceUsageCache.snapshot);
  }
  if (
    appResourceUsageInFlight
    && sameAppResourceUsageContexts(appResourceUsageInFlight.contexts, contexts)
    && appResourceUsageInFlight.localRuntimeConnectionPool === localRuntimeConnectionPool
  ) {
    return appResourceUsageInFlight.promise;
  }
  const promise = computeAppResourceUsageSnapshot(
    {
      getElectronMetrics: () => app.getAppMetrics(),
      getSystemMemoryMB,
      collector: getAppProcessMetricRowsCollector(),
    },
    collectAppResourceAttributionSources(contexts, localRuntimeConnectionPool),
  ).then((snapshot) => {
    appResourceUsageCache = {
      contexts: [...contexts],
      localRuntimeConnectionPool,
      sampledAtMs: Date.now(),
      snapshot,
    };
    return snapshot;
  }).finally(() => {
    if (appResourceUsageInFlight?.promise === promise) appResourceUsageInFlight = null;
  });
  appResourceUsageInFlight = {
    contexts: [...contexts],
    localRuntimeConnectionPool,
    promise,
  };
  return promise;
}

export type AppContext = {
  db: AdeDb | null;
  logger: Logger;
  project: ProjectInfo;
  hasUserSelectedProject: boolean;
  projectId: string;
  adeDir: string;
  getActiveRpcConnectionCount?: (() => number) | null;
  disposeTimers?: Array<ReturnType<typeof setTimeout>>;
  disposeHeadWatcher: () => void;
  keybindingsService: ReturnType<typeof createKeybindingsService> | null;
  agentToolsService: ReturnType<typeof createAgentToolsService> | null;
  adeCliService: ReturnType<typeof createAdeCliService>;
  devToolsService: ReturnType<typeof createDevToolsService> | null;
  onboardingService: ReturnType<typeof createOnboardingService> | null;
  laneService: ReturnType<typeof createLaneService> | null;
  laneWorktreeLockService?: LaneWorktreeLockService | null;
  laneEnvironmentService: ReturnType<typeof createLaneEnvironmentService> | null;
  laneTemplateService: ReturnType<typeof createLaneTemplateService> | null;
  portAllocationService: ReturnType<typeof createPortAllocationService> | null;
  laneProxyService: ReturnType<typeof createLaneProxyService> | null;
  oauthRedirectService: ReturnType<typeof createOAuthRedirectService> | null;
  runtimeDiagnosticsService: ReturnType<typeof createRuntimeDiagnosticsService> | null;
  rebaseSuggestionService: ReturnType<typeof createRebaseSuggestionService> | null;
  autoRebaseService: ReturnType<typeof createAutoRebaseService> | null;
  sessionService: ReturnType<typeof createSessionService> | null;
  processRegistry?: ProcessRegistryService | null;
  ptyService: ReturnType<typeof createPtyService> | null;
  diskPressureMonitor?: DiskPressureMonitor | null;
  diffService: ReturnType<typeof createDiffService> | null;
  fileService: ReturnType<typeof createFileService> | null;
  operationService: ReturnType<typeof createOperationService> | null;
  gitService: ReturnType<typeof createGitOperationsService> | null;
  conflictService: ReturnType<typeof createConflictService> | null;
  aiIntegrationService: ReturnType<typeof createAiIntegrationService> | null;
  agentChatService: ReturnType<typeof createAgentChatService> | null;
  computerUseArtifactBrokerService: ReturnType<typeof createComputerUseArtifactBrokerService> | null;
  iosSimulatorService?: ReturnType<typeof createIosSimulatorService> | null;
  appControlService?: ReturnType<typeof createAppControlService> | null;
  builtInBrowserService?: ReturnType<typeof createBuiltInBrowserService> | null;
  githubService: ReturnType<typeof createGithubService>;
  projectScaffoldService: ReturnType<typeof createProjectScaffoldService>;
  prService: ReturnType<typeof createPrService> | null;
  prPollingService: ReturnType<typeof createPrPollingService> | null;
  queueLandingService: ReturnType<typeof createQueueLandingService> | null;
  prSummaryService: ReturnType<typeof createPrSummaryService> | null;
  reviewService: ReturnType<typeof createReviewService> | null;
  searchService?: ReturnType<typeof createSearchService> | null;
  externalSessionsService?: ReturnType<typeof createExternalSessionsService> | null;
  jobEngine: ReturnType<typeof createJobEngine> | null;
  automationService: ReturnType<typeof createAutomationService> | null;
  automationPlannerService: ReturnType<typeof createAutomationPlannerService> | null;
  automationIngressService?: ReturnType<typeof createAutomationIngressService> | null;
  linearIngressService?: LinearIngressService | null;
  githubPollingService?: ReturnType<typeof createGithubPollingService> | null;
  orchestrationService?: ReturnType<typeof createOrchestrationService> | null;
  projectConfigService: ReturnType<typeof createProjectConfigService> | null;
  projectSecretService?: ReturnType<typeof createProjectSecretService> | null;
  processService: ReturnType<typeof createProcessService> | null;
  testService: ReturnType<typeof createTestService> | null;
  sessionDeltaService?: SessionDeltaService | null;
  ctoStateService?: ReturnType<typeof createCtoStateService> | null;
  ctoMemoryService?: CtoMemoryService | null;
  adeProjectService?: AdeProjectService | null;
  linearCredentialService?: ReturnType<typeof createLinearCredentialService> | null;
  linearIssueTracker?: ReturnType<typeof createLinearIssueTracker> | null;
  usageTrackingService?: ReturnType<typeof createUsageTrackingService> | null;
  storageInsightsService?: ReturnType<typeof createStorageInsightsService> | null;
  budgetCapService?: ReturnType<typeof createBudgetCapService> | null;
  configReloadService?: ConfigReloadService | null;
  syncHostService?: ReturnType<typeof createSyncHostService> | null;
  syncService?: ReturnType<typeof createSyncService> | null;
  rpcSocketServer?: NetServer;
  rpcSocketPath?: string;
  autoUpdateService?: ReturnType<typeof createAutoUpdateService> | null;
  updateInstallImpactProvider?: (() => Promise<UpdateInstallImpact>) | null;
  feedbackReporterService?: ReturnType<typeof createFeedbackReporterService> | null;
  transcriptionService?: ReturnType<typeof createTranscriptionService> | null;
};

type AppContextWith<K extends keyof AppContext> = AppContext & {
  [P in K]-?: NonNullable<AppContext[P]>;
};

function requireAppContextValue<K extends keyof AppContext>(
  ctx: AppContext,
  key: K,
): NonNullable<AppContext[K]> {
  const value = ctx[key];
  if (value == null) {
    throw new Error(
      "This project action is unavailable until ADE is connected to the project runtime. Reopen the project or wait for the runtime to connect.",
    );
  }
  return value as NonNullable<AppContext[K]>;
}

function requireAppContextServices<K extends keyof AppContext>(
  ctx: AppContext,
  keys: readonly K[],
): asserts ctx is AppContextWith<K> {
  for (const key of keys) {
    requireAppContextValue(ctx, key);
  }
}

function notifyLaneCreated(ctx: AppContext, lane: LaneSummary): void {
  ctx.automationService?.onLaneCreated?.({
    laneId: lane.id,
    laneName: lane.name,
    branchRef: lane.branchRef,
    folder: lane.folder ?? null,
  });
}

function clampLayout(layout: DockLayout): DockLayout {
  const out: DockLayout = {};
  for (const [k, v] of Object.entries(layout)) {
    if (!Number.isFinite(v)) continue;
    out[k] = Math.max(0, Math.min(100, v));
  }
  return out;
}

/**
 * Project chat-level runtime state and orchestration identity onto a terminal
 * session summary. Centralises the mapping so that every IPC endpoint that
 * enriches sessions with chat data produces identical results.
 */
function projectChatOntoSession(
  session: TerminalSessionSummary,
  chat: AgentChatSessionSummary,
): TerminalSessionSummary {
  const base: TerminalSessionSummary = {
    ...session,
    nextWakeAt: chat.nextWakeAt,
    ...(chat.claudeTag !== undefined ? { claudeTag: chat.claudeTag } : {}),
    ...(chat.orchestrationRunId
      ? {
          orchestrationRunId: chat.orchestrationRunId,
          orchestrationRole: chat.orchestrationRole,
          orchestrationTag: chat.orchestrationTag,
        }
      : {}),
    // Spawn lineage is independent of an orchestration run — a plain `ade new
    // chat` spawn sets a parent + spawnKind with no run/role. Project both
    // ungated so the sidebar can render the type pill and the live-children badge.
    ...(chat.orchestrationParentSessionId
      ? { orchestrationParentSessionId: chat.orchestrationParentSessionId }
      : {}),
    ...(chat.spawnKind ? { spawnKind: chat.spawnKind } : {}),
  };
  if (chat.awaitingInput) {
    return {
      ...base,
      runtimeState: "waiting-input" as const,
      chatIdleSinceAt: null,
      pendingInputItemId: chat.pendingInputItemId ?? session.pendingInputItemId ?? null,
    };
  }
  if (chat.status === "active") {
    return { ...base, runtimeState: "running" as const, chatIdleSinceAt: null };
  }
  if (chat.status === "idle" || chat.status === "ended") {
    return { ...base, runtimeState: "idle" as const, chatIdleSinceAt: chat.idleSinceAt ?? null };
  }
  return base;
}

function escapeCsvCell(value: string | null | undefined): string {
  const input = value ?? "";
  return /[",\r\n]/.test(input) ? `"${input.replace(/"/g, "\"\"")}"` : input;
}

const AI_USAGE_FEATURE_KEYS: AiFeatureKey[] = [
  "narratives",
  "conflict_proposals",
  "commit_messages",
  "pr_descriptions",
  "terminal_summaries",
  "initial_context"
];

function isDatabaseClosedError(error: unknown): boolean {
  return error instanceof Error && /database closed/i.test(error.message);
}

function getUnavailableAiStatus(): AiSettingsStatus {
  return {
    mode: "guest",
    availableProviders: {
      claude: {
        binary: {
          present: false,
          source: "missing",
          path: null,
        },
        auth: {
          ready: false,
          mode: "none",
          detail: "AI integration service unavailable.",
        },
      },
      codex: false,
      cursor: false,
      droid: false,
    },
    models: {
      claude: [],
      codex: [],
      cursor: [],
      droid: [],
    },
    detectedAuth: [],
    providerConnections: {
      claude: {
        provider: "claude",
        authAvailable: false,
        runtimeDetected: false,
        runtimeAvailable: false,
        usageAvailable: false,
        path: null,
        blocker: "AI integration service unavailable.",
        lastCheckedAt: new Date(0).toISOString(),
        sources: [],
      },
      codex: {
        provider: "codex",
        authAvailable: false,
        runtimeDetected: false,
        runtimeAvailable: false,
        usageAvailable: false,
        path: null,
        blocker: "AI integration service unavailable.",
        lastCheckedAt: new Date(0).toISOString(),
        sources: [],
      },
      cursor: {
        provider: "cursor",
        authAvailable: false,
        runtimeDetected: false,
        runtimeAvailable: false,
        usageAvailable: false,
        path: null,
        blocker: "AI integration service unavailable.",
        lastCheckedAt: new Date(0).toISOString(),
        sources: [],
      },
      droid: {
        provider: "droid",
        authAvailable: false,
        runtimeDetected: false,
        runtimeAvailable: false,
        usageAvailable: false,
        path: null,
        blocker: "AI integration service unavailable.",
        lastCheckedAt: new Date(0).toISOString(),
        sources: [],
      },
    },
    features: AI_USAGE_FEATURE_KEYS.map((feature) => ({
      feature,
      enabled: false,
      dailyUsage: 0,
      dailyLimit: null,
    })),
    runtimeConnections: {},
    availableModelIds: [],
    opencodeBinaryInstalled: false,
    opencodeBinarySource: "missing" as const,
    opencodeInventoryError: null,
    opencodeProviders: [],
  };
}

function detectClaudeAuthModeFromConnection(
  connection: AiProviderConnections["claude"],
): AiClaudeAvailability["auth"]["mode"] {
  const localCredentials = connection.sources.find((source) => source.kind === "local-credentials" && source.detected);
  if (localCredentials?.source === "claude-credentials-file" || localCredentials?.source === "macos-keychain") return "oauth";
  if (localCredentials) return "api_key";
  const cli = connection.sources.find((source) => source.kind === "cli" && source.detected);
  if (cli || connection.authAvailable) return "oauth";
  return "none";
}

function resolveBundledClaudeBinary(): Pick<AiClaudeAvailability["binary"], "present" | "source" | "path"> {
  const resolved = resolveClaudeCodeExecutable({ env: { PATH: "" } });
  return resolved.source === "bundled"
    ? { present: true, source: "bundled", path: resolved.path }
    : { present: false, source: "missing", path: null };
}

function buildClaudeAvailabilityFromConnection(
  connection: AiProviderConnections["claude"],
): AiClaudeAvailability {
  const bundledBinary = resolveBundledClaudeBinary();
  const binary = bundledBinary.present
    ? bundledBinary
    : {
        present: connection.runtimeDetected,
        source: connection.runtimeDetected ? "path" as const : "missing" as const,
        path: connection.path,
      };
  const normalizedBlocker = connection.blocker?.toLowerCase() ?? "";
  const blockerIsOnlyAboutPath = binary.source === "bundled"
    && [
      "could not find the claude cli",
      "cli not found",
      "claude cli is installed",
      "add that bin directory",
    ].some((needle) => normalizedBlocker.includes(needle));
  const ready = binary.present
    && connection.authAvailable
    && (connection.runtimeAvailable || blockerIsOnlyAboutPath || !connection.blocker);
  const authMode = detectClaudeAuthModeFromConnection(connection);
  return {
    binary,
    auth: {
      ready,
      mode: ready ? authMode : "none",
      detail: ready ? null : connection.blocker,
    },
  };
}

function redactedCliAuthFromStatuses(
  cliStatuses: Awaited<ReturnType<typeof detectCliAuthStatuses>>,
): AiDetectedAuth[] {
  return cliStatuses
    .filter((status) => status.installed)
    .map((status) => ({
      type: "cli-subscription" as const,
      cli: status.cli,
      path: status.path ?? status.cli,
      authenticated: status.authenticated,
      verified: status.verified,
    }));
}

async function buildGlobalAiStatus(args?: { force?: boolean }): Promise<AiSettingsStatus> {
  const cliStatuses = await detectCliAuthStatuses({
    force: args?.force === true,
    skipAuthProbe: args?.force !== true,
  });
  const providerConnections = await buildProviderConnections(cliStatuses);
  const hasConfirmedSubscriptionProvider =
    providerConnections.claude.authAvailable ||
    providerConnections.codex.authAvailable ||
    providerConnections.cursor.authAvailable ||
    providerConnections.droid.authAvailable ||
    cliStatuses.some((entry) => entry.installed && entry.authenticated);

  // This no-project fallback reports machine-level provider/auth signals only;
  // feature flags, usage counters, and model catalogs remain project-scoped.
  return {
    mode: hasConfirmedSubscriptionProvider ? "subscription" : "guest",
    availableProviders: {
      claude: buildClaudeAvailabilityFromConnection(providerConnections.claude),
      codex: providerConnections.codex.runtimeAvailable,
      cursor: providerConnections.cursor.runtimeAvailable,
      droid: providerConnections.droid.runtimeAvailable,
    },
    models: {
      claude: [],
      codex: [],
      cursor: [],
      droid: [],
    },
    detectedAuth: redactedCliAuthFromStatuses(cliStatuses),
    providerConnections,
    features: AI_USAGE_FEATURE_KEYS.map((feature) => ({
      feature,
      enabled: false,
      dailyUsage: 0,
      dailyLimit: null,
    })),
    runtimeConnections: {},
    availableModelIds: [],
    opencodeBinaryInstalled: false,
    opencodeBinarySource: "missing",
    opencodeInventoryError: null,
    opencodeProviders: [],
  };
}

/**
 * Strict resolver for identity-pinned sessions (CTO + worker agents). Requires
 * an actual primary lane and never slips a foreign lane through via a
 * `lanes[0]` fallback — if there is no primary lane the caller must surface
 * the error rather than silently landing the identity on a non-primary lane.
 */
async function resolvePrimaryLaneIdOnly(ctx: AppContext): Promise<string> {
  requireAppContextServices(ctx, ["laneService"] as const);
  await ctx.laneService.ensurePrimaryLane().catch(() => {});
  const lanes = await ctx.laneService.list({ includeArchived: false, includeStatus: false });
  return lanes.find((lane) => lane.laneType === "primary")?.id ?? "";
}

async function resolveLaneOverlayContext(ctx: AppContext, laneId: string) {
  requireAppContextServices(ctx, ["laneService", "projectConfigService"] as const);
  const lanes = await ctx.laneService.list({ includeStatus: false });
  const lane = lanes.find((entry) => entry.id === laneId);
  if (!lane) throw new Error(`Lane not found: ${laneId}`);

  const config = ctx.projectConfigService.getEffective();
  const { matchLaneOverlayPolicies } = await import("../config/laneOverlayMatcher");
  const overlayOverrides = matchLaneOverlayPolicies(lane, config.laneOverlayPolicies ?? []);
  const lease = ctx.portAllocationService?.getLease(lane.id) ?? null;
  const overrides = applyLeaseToOverrides(overlayOverrides, lease);
  const envInitConfig = ctx.laneEnvironmentService?.resolveEnvInitConfig(config.laneEnvInit, overrides);

  return {
    lane,
    overrides,
    envInitConfig,
    lease
  };
}

function mergeLaneDockerConfig(
  current: { composePath?: string; services?: string[]; projectPrefix?: string } | undefined,
  next: { composePath?: string; services?: string[]; projectPrefix?: string } | undefined
) {
  if (!current && !next) return undefined;
  if (!current) return next ? { ...next, ...(next.services ? { services: [...next.services] } : {}) } : undefined;
  if (!next) return { ...current, ...(current.services ? { services: [...current.services] } : {}) };
  return {
    ...current,
    ...next,
    ...(next.services != null
      ? { services: [...next.services] }
      : current.services != null
        ? { services: [...current.services] }
        : {})
  };
}

function mergeLaneEnvInitConfig(
  current: LaneEnvInitConfig | undefined,
  next: LaneEnvInitConfig | undefined
): LaneEnvInitConfig | undefined {
  if (!current && !next) return undefined;
  if (!current) {
    return next
      ? {
          ...(next.envFiles ? { envFiles: [...next.envFiles] } : {}),
          ...(mergeLaneDockerConfig(undefined, next.docker) ? { docker: mergeLaneDockerConfig(undefined, next.docker) } : {}),
          ...(next.dependencies ? { dependencies: [...next.dependencies] } : {}),
          ...(next.mountPoints ? { mountPoints: [...next.mountPoints] } : {})
        }
      : undefined;
  }
  if (!next) {
    return {
      ...(current.envFiles ? { envFiles: [...current.envFiles] } : {}),
      ...(mergeLaneDockerConfig(undefined, current.docker) ? { docker: mergeLaneDockerConfig(undefined, current.docker) } : {}),
      ...(current.dependencies ? { dependencies: [...current.dependencies] } : {}),
      ...(current.mountPoints ? { mountPoints: [...current.mountPoints] } : {})
    };
  }
  return {
    envFiles: [...(current.envFiles ?? []), ...(next.envFiles ?? [])],
    ...(mergeLaneDockerConfig(current.docker, next.docker) ? { docker: mergeLaneDockerConfig(current.docker, next.docker) } : {}),
    dependencies: [...(current.dependencies ?? []), ...(next.dependencies ?? [])],
    mountPoints: [...(current.mountPoints ?? []), ...(next.mountPoints ?? [])]
  };
}

function mergeLaneOverrides(base: LaneOverlayOverrides, next: Partial<LaneOverlayOverrides>): LaneOverlayOverrides {
  return {
    ...base,
    ...next,
    ...(base.env || next.env ? { env: { ...(base.env ?? {}), ...(next.env ?? {}) } } : {}),
    ...(base.processIds || next.processIds ? { processIds: [...(next.processIds ?? base.processIds ?? [])] } : {}),
    ...(base.testSuiteIds || next.testSuiteIds ? { testSuiteIds: [...(next.testSuiteIds ?? base.testSuiteIds ?? [])] } : {}),
    ...(mergeLaneEnvInitConfig(base.envInit, next.envInit) ? { envInit: mergeLaneEnvInitConfig(base.envInit, next.envInit) } : {})
  };
}

function applyLeaseToOverrides(overrides: LaneOverlayOverrides, lease: PortLease | null): LaneOverlayOverrides {
  if (!lease || lease.status !== "active" || overrides.portRange) {
    return { ...overrides };
  }
  return {
    ...overrides,
    portRange: { start: lease.rangeStart, end: lease.rangeEnd }
  };
}

async function ensureLanePortLease(ctx: AppContext, laneId: string): Promise<PortLease | null> {
  if (!ctx.portAllocationService) return null;
  requireAppContextServices(ctx, ["laneService"] as const);
  const activeLane = (await ctx.laneService.list({ includeArchived: false, includeStatus: false })).find((entry) => entry.id === laneId);
  if (!activeLane) throw new Error(`Lane not found: ${laneId}`);
  const existing = ctx.portAllocationService.getLease(laneId);
  if (existing?.status === "active") return existing;
  return ctx.portAllocationService.acquire(laneId);
}

async function buildLinearConnectionStatus(
  ctx: AppContext,
  tokenStored: boolean,
  message?: string
): Promise<LinearConnectionStatus> {
  const credentialStatus = ctx.linearCredentialService?.getStatus() ?? {
    authMode: null,
    oauthConfigured: false,
    tokenExpiresAt: null,
  };
  if (!ctx.linearIssueTracker || !tokenStored) {
    return {
      tokenStored,
      connected: false,
      viewerId: null,
      viewerName: null,
      checkedAt: nowIso(),
      authMode: credentialStatus.authMode,
      oauthAvailable: credentialStatus.oauthConfigured,
      tokenExpiresAt: credentialStatus.tokenExpiresAt,
      message: message ?? (tokenStored ? "Linear tracker service unavailable." : "Linear token not configured."),
    };
  }

  const status = await ctx.linearIssueTracker.getConnectionStatus();
  return {
    tokenStored,
    connected: status.connected,
    viewerId: status.viewerId,
    viewerName: status.viewerName,
    organizationId: status.organizationId,
    organizationName: status.organizationName,
    organizationUrlKey: status.organizationUrlKey,
    organizationLogoUrl: status.organizationLogoUrl,
    projectCount: undefined,
    projectPreview: undefined,
    checkedAt: nowIso(),
    authMode: credentialStatus.authMode,
    oauthAvailable: credentialStatus.oauthConfigured,
    tokenExpiresAt: credentialStatus.tokenExpiresAt,
    message: formatLinearConnectionMessage(status.message, credentialStatus.authMode),
  };
}

function formatLinearConnectionMessage(
  message: string | null | undefined,
  authMode: "manual" | "oauth" | null | undefined,
): string | null {
  const trimmed = message?.trim();
  if (
    authMode === "manual"
    && trimmed
    && /authentication required|not authenticated/i.test(trimmed)
  ) {
    return "Linear rejected the API key. Paste a Linear personal API key from linear.app/settings/api; it should start with lin_api_.";
  }
  return trimmed || null;
}

function isChatToolType(toolType: string | null | undefined): boolean {
  if (!toolType) return false;
  const t = toolType.trim().toLowerCase();
  return t === "cursor" || t.endsWith("-chat");
}

function sessionNeedsResumeTargetHydration(session: {
  tracked: boolean;
  status: string;
  toolType: string | null;
  resumeMetadata?: { targetId?: string | null } | null;
}): boolean {
  if (!session.tracked || session.status === "running") return false;
  if (sanitizeResumeTargetId(session.resumeMetadata?.targetId ?? null)) return false;
  return (
    session.toolType === "claude"
    || session.toolType === "codex"
    || session.toolType === "claude-orchestrated"
    || session.toolType === "codex-orchestrated"
  );
}

function inferPrAiProvider(modelId: string): "codex" | "claude" {
  const descriptor = getModelById(modelId);
  return descriptor?.family === "anthropic" ? "claude" : "codex";
}

export function collectPrAiSourceLaneIds(context: PrAiResolutionContext): string[] {
  const sourceLaneIds = new Set<string>();
  const add = (value: string | null | undefined) => {
    const normalized = typeof value === "string" ? value.trim() : "";
    if (normalized) sourceLaneIds.add(normalized);
  };
  for (const laneId of context.sourceLaneIds ?? []) {
    add(laneId);
  }
  add(context.sourceLaneId ?? null);
  if (context.sourceTab !== "integration") {
    add(context.laneId ?? null);
  }
  return Array.from(sourceLaneIds);
}

function mapPrAiPermissionMode(mode: PrAgentPermissionMode): AgentChatPermissionMode {
  if (mode === "full_edit") return "full-auto";
  if (mode === "guarded_edit") return "edit";
  if (mode === "read_only") return "plan";
  return mode;
}

/**
 * Map a PR resolver permission mode to provider-native permission fields for AgentChatCreateArgs.
 */
function mapPrAiPermissionModeToNativeFields(
  mode: PrAgentPermissionMode,
  provider: string,
): Partial<Pick<AgentChatCreateArgs, "claudePermissionMode" | "codexApprovalPolicy" | "codexSandbox" | "codexConfigSource" | "opencodePermissionMode" | "droidPermissionMode" | "cursorModeId">> {
  const legacy = mapPrAiPermissionMode(mode);
  if (provider === "claude") {
    const map: Record<string, AgentChatClaudePermissionMode> = {
      "full-auto": "bypassPermissions",
      "edit": "acceptEdits",
      "plan": "plan",
      "default": "default",
    };
    return { claudePermissionMode: map[legacy] ?? "default" };
  }
  if (provider === "codex") {
    if (legacy === "config-toml") {
      return {
        codexApprovalPolicy: "on-request",
        codexSandbox: "workspace-write",
        codexConfigSource: "config-toml",
      };
    }
    if (legacy === "full-auto") return { codexApprovalPolicy: "never", codexSandbox: "danger-full-access", codexConfigSource: "flags" };
    if (legacy === "edit" || legacy === "default") return { codexApprovalPolicy: "on-request", codexSandbox: "workspace-write", codexConfigSource: "flags" };
    return { codexApprovalPolicy: "on-request", codexSandbox: "read-only", codexConfigSource: "flags" };
  }
  if (provider === "droid") {
    if (legacy === "full-auto") return { droidPermissionMode: "auto-high" };
    if (legacy === "edit") return { droidPermissionMode: "auto-low" };
    return { droidPermissionMode: "read-only" };
  }
  if (provider === "cursor") {
    if (legacy === "full-auto") return { cursorModeId: "full-auto" };
    if (legacy === "plan") return { cursorModeId: "plan" };
    return { cursorModeId: "agent" };
  }
  const umap: Record<string, AgentChatOpenCodePermissionMode> = {
    "full-auto": "full-auto",
    "edit": "edit",
    "plan": "plan",
    "config-toml": "config-toml",
  };
  return { opencodePermissionMode: umap[legacy] ?? "edit" };
}

function deriveAiPermissionModeFromSummary(
  summary: Pick<AgentChatSessionSummary, "provider" | "permissionMode" | "claudePermissionMode" | "codexApprovalPolicy" | "codexSandbox" | "codexConfigSource" | "opencodePermissionMode" | "droidPermissionMode" | "cursorModeId"> | null | undefined,
): PrAgentPermissionMode | null {
  if (!summary) return null;
  if (summary.permissionMode) return summary.permissionMode;
  if (summary.provider === "claude") {
    if (summary.claudePermissionMode === "bypassPermissions") return "full-auto";
    if (summary.claudePermissionMode === "acceptEdits") return "edit";
    if (summary.claudePermissionMode === "plan") return "plan";
    if (summary.claudePermissionMode === "default") return "default";
    return null;
  }
  if (summary.provider === "codex") {
    if (summary.codexConfigSource === "config-toml") return "config-toml";
    if (summary.codexApprovalPolicy === "never" && summary.codexSandbox === "danger-full-access") return "full-auto";
    if (summary.codexSandbox === "workspace-write") return "default";
    if (summary.codexSandbox === "read-only") return "plan";
    return null;
  }
  if (summary.provider === "droid") {
    if (summary.droidPermissionMode === "auto-high") return "full-auto";
    if (summary.droidPermissionMode === "auto-low" || summary.droidPermissionMode === "auto-medium") return "edit";
    if (summary.droidPermissionMode === "read-only") return "plan";
    return null;
  }
  if (summary.provider === "cursor") {
    if (summary.cursorModeId === "full-auto") return "full-auto";
    if (summary.cursorModeId === "agent") return "edit";
    if (summary.cursorModeId === "ask" || summary.cursorModeId === "plan") return "plan";
    return null;
  }
  if (summary.opencodePermissionMode === "full-auto") return "full-auto";
  if (summary.opencodePermissionMode === "edit") return "edit";
  if (summary.opencodePermissionMode === "plan") return "plan";
  if (summary.opencodePermissionMode === "config-toml") return "config-toml";
  return null;
}

function mapExternalResolverStatusToPrAi(status: ConflictExternalResolverRunSummary["status"]): PrAiResolutionSessionStatus {
  if (status === "completed") return "completed";
  if (status === "failed" || status === "blocked") return "failed";
  if (status === "canceled") return "cancelled";
  return "running";
}

function buildPrAiDisplayText(context: PrAiResolutionContext): string {
  if (context.sourceTab === "rebase") {
    return "Resolve this rebase with AI.";
  }
  if (context.sourceTab === "queue") {
    return "Resolve this queued PR with AI.";
  }
  if (context.sourceTab === "integration") {
    return context.proposalId
      ? "Resolve this integration proposal with AI."
      : "Resolve this integration PR with AI.";
  }
  return "Resolve this PR with AI.";
}

function getAllowedDirs(getCtx: () => AppContext): string[] {
  const projectRoot = getCtx().project.rootPath;
  return [
    projectRoot,
    app.getPath("downloads"),
    app.getPath("documents"),
    app.getPath("temp"),
  ];
}

export function registerIpc({
  getCtx,
  getResourceUsageContexts,
  getSyncService,
  resolveSyncService,
  runWithIpcWindow,
  getWindowSession,
  getProjectContext,
  setWindowProjectTabs,
  bindRemoteProject,
  localRuntimeConnectionPool,
  projectRecoveryConnectionPool,
  createWindow,
  closeWindow,
  switchProjectFromDialog,
  closeCurrentProject,
  closeProjectByPath,
  globalStatePath,
  builtInBrowserService,
  productAnalyticsService,
}: {
  getCtx: () => AppContext;
  getResourceUsageContexts?: () => AppContext[];
  getSyncService?: () => ReturnType<typeof createSyncService> | null | undefined;
  resolveSyncService?: () => Promise<ReturnType<typeof createSyncService> | null | undefined>;
  runWithIpcWindow?: <T>(event: { sender: Electron.WebContents }, fn: () => T | Promise<T>) => T | Promise<T>;
  getWindowSession?: (windowId: number | null) => { windowId: number | null; project: ProjectInfo | null; binding: OpenProjectBinding | null; openProjectTabs?: ProjectInfo[]; pendingLocalProjectRoots?: string[] };
  getProjectContext?: (projectRoot: string) => AppContext | null | undefined;
  setWindowProjectTabs?: (windowId: number | null, rootPaths: string[]) => ProjectInfo[];
  bindRemoteProject?: (windowId: number | null, binding: OpenProjectBinding & { kind: "remote" }) => void;
  localRuntimeConnectionPool?: LocalRuntimeConnectionPool | null;
  projectRecoveryConnectionPool?: LocalRuntimeConnectionPool | null;
  createWindow?: (args?: { projectRoot?: string | null }) => Promise<{ windowId: number | null; project: ProjectInfo | null }>;
  closeWindow?: (windowId: number | null) => Promise<{ closed: boolean }>;
  switchProjectFromDialog: (selectedPath: string) => Promise<ProjectInfo>;
  closeCurrentProject: () => Promise<void>;
  closeProjectByPath: (projectRoot: string) => Promise<void>;
  globalStatePath: string;
  builtInBrowserService?: ReturnType<typeof createBuiltInBrowserService> | null;
  productAnalyticsService?: ProductAnalyticsService;
}) {
  // Process-scoped by design: renderer reloads and additional windows in the
  // same app launch do not repeat the account choice, while a full ADE relaunch
  // creates a fresh IPC registration and shows it again when signed out.
  let launchGateResolved = false;
  const watcherCleanupBoundSenders = new Set<number>();
  let linearOAuthService: LinearOAuthService | null = null;
  let linearOAuthServiceAdeDir: string | null = null;
  const appControlRateBuckets = new Map<string, { windowStartMs: number; count: number }>();
  const builtInBrowserRateBuckets = new Map<string, { windowStartMs: number; count: number }>();
  let fallbackAnalyticsEnabled = true;
  const fallbackAnalyticsStatus = (): ProductAnalyticsStatus => ({
    configured: false,
    enabled: fallbackAnalyticsEnabled,
    effective: false,
    host: "https://us.i.posthog.com",
    dailyBudget: 200,
    acceptedToday: 0,
    droppedToday: 0,
    day: new Date().toISOString().slice(0, 10),
  });
  const projectRecoveryService = projectRecoveryConnectionPool
    ? createProjectRecoveryService({
        adeHome: process.env.ADE_HOME?.trim() || path.join(app.getPath("home"), ".ade"),
        logger: getCtx().logger,
        connectionPool: projectRecoveryConnectionPool,
      })
    : null;

  const getOptionalSyncService = (): ReturnType<typeof createSyncService> | null => {
    if (getSyncService) return getSyncService() ?? null;
    return getCtx().syncService ?? null;
  };
  const resolveOptionalSyncService = async (): Promise<ReturnType<typeof createSyncService> | null> =>
    resolveSyncService
      ? (await resolveSyncService()) ?? null
      : getOptionalSyncService();

  const requireSyncService = async (): Promise<ReturnType<typeof createSyncService>> => {
    const service = await resolveOptionalSyncService();
    if (!service) {
      throw new Error("Sync service is not available.");
    }
    return service;
  };

  const normalizeWelcomeVideoTimestamp = (value: unknown): string | null => {
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    if (!trimmed || Number.isNaN(Date.parse(trimmed))) return null;
    return trimmed;
  };

  const normalizeWelcomeVideoState = (
    value: AppWelcomeVideoState | null | undefined,
  ): AppWelcomeVideoState => {
    if (
      value?.videoId === ADE_WELCOME_VIDEO_ID &&
      value.version === ADE_WELCOME_VIDEO_VERSION
    ) {
      return {
        videoId: ADE_WELCOME_VIDEO_ID,
        version: ADE_WELCOME_VIDEO_VERSION,
        completedAt: normalizeWelcomeVideoTimestamp(value.completedAt),
        dismissedAt: normalizeWelcomeVideoTimestamp(value.dismissedAt),
      };
    }
    return {
      videoId: ADE_WELCOME_VIDEO_ID,
      version: ADE_WELCOME_VIDEO_VERSION,
      completedAt: null,
      dismissedAt: null,
    };
  };

  const getLocalRuntimeRootForEvent = (event: { sender: Electron.WebContents }): string | null => {
    if (!getWindowSession) return null;
    const windowId = BrowserWindow.fromWebContents(event.sender)?.id ?? null;
    const session = getWindowSession(windowId);
    const binding = session?.binding;
    if (binding?.kind === "local") return binding.rootPath;
    return session?.project?.rootPath ?? null;
  };

  const tryLocalRuntimeSync = async <T>(
    event: { sender: Electron.WebContents },
    action: (pool: LocalRuntimeConnectionPool, rootPath: string) => Promise<T>,
  ): Promise<T | null> => {
    if (!localRuntimeConnectionPool) return null;
    const rootPath = getLocalRuntimeRootForEvent(event);
    if (!rootPath) return null;
    return await action(localRuntimeConnectionPool, rootPath);
  };

  const tryRuntimeSync = async <T>(
    event: { sender: Electron.WebContents },
    method: string,
    params: Record<string, unknown>,
    projectAction?: (pool: LocalRuntimeConnectionPool, rootPath: string) => Promise<T>,
  ): Promise<{ handled: true; result: T } | { handled: false }> => {
    if (!localRuntimeConnectionPool) return { handled: false };
    const rootPath = getLocalRuntimeRootForEvent(event);
    if (rootPath && projectAction) {
      try {
        return {
          handled: true,
          result: await projectAction(localRuntimeConnectionPool, rootPath),
        };
      } catch (error) {
        if (!isSyncServiceUnavailableError(error)) throw error;
      }
    }
    try {
      return {
        handled: true,
        result: await localRuntimeConnectionPool.callSync<T>(method, params),
      };
    } catch (error) {
      if (isSyncServiceUnavailableError(error)) return { handled: false };
      throw error;
    }
  };

  // Backend services use Error.code for known failures (e.g.
  // "github_not_connected", "remote_already_exists"). Electron IPC strips
  // custom properties from thrown errors, so we re-throw with the code
  // prepended to the message. Renderer matches on the prefix.
  const surfaceCodedError = (error: unknown, meta?: { rootPath?: string }): never => {
    if (error instanceof Error) {
      const code = (error as Error & { code?: unknown }).code;
      if (typeof code === "string" && code.length > 0) {
        const parsed = parseCodedErrorMessage(error);
        const rootPath = meta?.rootPath ?? parsed.rootPath;
        // Re-encode when the message isn't yet prefixed, OR when we have a
        // rootPath to attach that the message doesn't already carry — an
        // already-`${code}:`-prefixed rethrow must not drop meta.rootPath.
        const needsWrap = !error.message.startsWith(`${code}:`) || Boolean(rootPath && !parsed.rootPath);
        if (needsWrap) {
          throw new Error(encodeCodedErrorMessage(code, parsed.message, rootPath ? { rootPath } : undefined));
        }
      }
    }
    throw error;
  };

  const getLinearOAuthBridge = (ctx: AppContext): LinearOAuthService => {
    if (!ctx.linearCredentialService) {
      throw new Error("Linear credential service is not available.");
    }
    if (!linearOAuthService || linearOAuthServiceAdeDir !== ctx.adeDir) {
      linearOAuthService?.dispose();
      linearOAuthService = createLinearOAuthService({
        credentials: ctx.linearCredentialService,
        logger: ctx.logger,
      });
      linearOAuthServiceAdeDir = ctx.adeDir;
    }
    return linearOAuthService;
  };

  const withIpcTiming = async <T>(
    ctx: AppContext,
    op: string,
    fn: () => Promise<T>,
    meta: Record<string, unknown> = {}
  ): Promise<T> => {
    const startedAt = Date.now();
    try {
      const result = await fn();
      const durationMs = Date.now() - startedAt;
      if (durationMs >= 120) {
        ctx.logger.debug("ipc.timing", { op, durationMs, ...meta });
      }
      return result;
    } catch (error) {
      const durationMs = Date.now() - startedAt;
      ctx.logger.warn("ipc.timing_failed", {
        op,
        durationMs,
        err: getErrorMessage(error),
        ...meta
      });
      throw error;
    }
  };

  const traceIpcInvokes = isPerfRunActive() || !app.isPackaged || process.env.ADE_TRACE_IPC === "1" || process.env.ADE_TRACE_IPC === "verbose";
  const traceEveryIpcInvoke = process.env.ADE_TRACE_IPC === "verbose";
  let ipcInvokeSeq = 0;

  // Channel-aware redaction: these channels carry sensitive payloads
  // (commands, env vars, typed text, terminal data) that must NOT land in
  // structured trace logs. Redact by replacing the field with `[redacted]`
  // before the generic summarizer descends into the args.
  const ipcChannelRedactionMap: Record<string, ReadonlySet<string>> = {
    [IPC.appControlLaunch]: new Set(["command", "env"]),
    [IPC.appControlLaunchInTerminal]: new Set(["command", "env"]),
    [IPC.appControlTypeText]: new Set(["text"]),
    [IPC.appControlDispatchKey]: new Set(["text", "unmodifiedText", "key", "code"]),
    [IPC.terminalWrite]: new Set(["data"]),
    [IPC.ptySendToSession]: new Set(["text"]),
    [IPC.ptyWrite]: new Set(["data"]),
    [IPC.appOpenExternal]: new Set(["url"]),
    [IPC.builtInBrowserNavigate]: new Set(["url"]),
    [IPC.builtInBrowserCreateTab]: new Set(["url"]),
    [IPC.builtInBrowserShowPanel]: new Set(["url"]),
    [IPC.transcriptionTranscribe]: new Set(["pcm"]),
    [IPC.accountPollLogin]: new Set(["sessionId"]),
    [IPC.accountCancelLogin]: new Set(["sessionId"]),
    [IPC.accountPairMachine]: new Set(["machineKey"]),
    [IPC.accountRemoveMachine]: new Set(["machineKey"]),
  };

  const redactIpcArgsForChannel = (channel: string, args: unknown[]): unknown[] => {
    const redactKeys = ipcChannelRedactionMap[channel];
    if (!redactKeys || redactKeys.size === 0) return args;
    return args.map((arg) => {
      if (!arg || typeof arg !== "object" || Array.isArray(arg)) return arg;
      const record = arg as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const [key, val] of Object.entries(record)) {
        out[key] = redactKeys.has(key) ? "[redacted]" : val;
      }
      return out;
    });
  };

  const shouldRedactIpcKey = (key: string | undefined): boolean => {
    if (!key) return false;
    const normalized = key.toLowerCase();
    return normalized.includes("token")
      || normalized.includes("secret")
      || normalized.includes("password")
      || normalized.includes("authorization")
      || normalized === "apikey"
      || normalized === "api_key"
      || normalized === "pairingpin"
      || normalized === "pairing_pin";
  };

  const summarizeIpcValue = (value: unknown, depth = 0, key?: string): unknown => {
    if (shouldRedactIpcKey(key)) return "[redacted]";
    if (value == null) return value;
    if (typeof value === "string") {
      return value.length > 160 ? `${value.slice(0, 157)}...` : value;
    }
    if (typeof value === "number" || typeof value === "boolean") return value;
    if (typeof value === "bigint") return value.toString();
    if (value instanceof Date) return value.toISOString();
    if (Array.isArray(value)) {
      if (depth >= 1) return `[array:${value.length}]`;
      return {
        kind: "array",
        length: value.length,
        sample: value.slice(0, 3).map((item) => summarizeIpcValue(item, depth + 1)),
      };
    }
    if (typeof value === "object") {
      if (depth >= 1) return "[object]";
      const record = value as Record<string, unknown>;
      const entries = Object.entries(record).slice(0, 8);
      return Object.fromEntries(entries.map(([entryKey, entryValue]) => [entryKey, summarizeIpcValue(entryValue, depth + 1, entryKey)]));
    }
    return typeof value;
  };

  const summarizeIpcArg = (value: unknown): unknown => {
    if (!value || typeof value !== "object" || Array.isArray(value) || value instanceof Date) {
      return summarizeIpcValue(value);
    }
    const record = value as Record<string, unknown>;
    const entries = Object.entries(record).slice(0, 8);
    return Object.fromEntries(entries.map(([key, entryValue]) => [key, summarizeIpcValue(entryValue, 1, key)]));
  };

  const summarizeIpcArgs = (args: unknown[]): unknown => ({
    kind: "array",
    length: args.length,
    ...(args.length > 0 ? { arg0: summarizeIpcArg(args[0]) } : {}),
    ...(args.length > 1 ? { arg1: summarizeIpcArg(args[1]) } : {}),
    ...(args.length > 2 ? { arg2: summarizeIpcArg(args[2]) } : {}),
  });

  const redactIpcResultForChannel = (channel: string, result: unknown): unknown => {
    if (channel === IPC.transcriptionTranscribe) {
      if (!result || typeof result !== "object" || Array.isArray(result)) return "[redacted]";
      return {
        ...(result as Record<string, unknown>),
        raw: "[redacted]",
        cleaned: "[redacted]",
      };
    }
    if (!result || typeof result !== "object" || Array.isArray(result)) return result;
    const record = result as Record<string, unknown>;
    if (channel === IPC.accountStartLogin) {
      return {
        ...record,
        sessionId: "[redacted]",
        authorizeUrl: "[redacted]",
      };
    }
    if (
      channel === IPC.accountStatus
      || channel === IPC.accountCancelLogin
      || channel === IPC.accountSignOut
    ) {
      return {
        ...record,
        userId: "[redacted]",
        email: "[redacted]",
        name: "[redacted]",
        imageUrl: "[redacted]",
      };
    }
    if (channel === IPC.accountPollLogin) {
      const authStatus = record.authStatus;
      return {
        ...record,
        authStatus: authStatus && typeof authStatus === "object" && !Array.isArray(authStatus)
          ? {
              ...(authStatus as Record<string, unknown>),
              userId: "[redacted]",
              email: "[redacted]",
              name: "[redacted]",
              imageUrl: "[redacted]",
            }
          : authStatus,
      };
    }
    if (channel === IPC.accountListMachines) {
      return {
        ...record,
        machines: Array.isArray(record.machines)
          ? record.machines.map((machine) => (
              machine && typeof machine === "object" && !Array.isArray(machine)
                ? {
                    ...(machine as Record<string, unknown>),
                    machineKey: "[redacted]",
                    deviceId: "[redacted]",
                    name: "[redacted]",
                    reachableEndpoints: "[redacted]",
                  }
                : machine
            ))
          : record.machines,
      };
    }
    if (channel === IPC.accountPairMachine) {
      return {
        ...record,
        targetId: "[redacted]",
        machineKey: "[redacted]",
        deviceId: "[redacted]",
        name: "[redacted]",
      };
    }
    if (channel === IPC.accountGetLocalMachineIdentity) {
      return {
        ...record,
        machineKey: "[redacted]",
        deviceId: "[redacted]",
      };
    }
    if (channel === IPC.accountRemoveMachine) {
      return {
        ...record,
        machineKey: "[redacted]",
      };
    }
    return result;
  };

  const getTraceLogger = (): Pick<Logger, "info" | "warn"> => {
    try {
      return getCtx().logger;
    } catch {
      return {
        info: (event: string, meta?: Record<string, unknown>) => console.log(`[info] ${event}`, meta ?? ""),
        warn: (event: string, meta?: Record<string, unknown>) => console.warn(`[warn] ${event}`, meta ?? ""),
      };
    }
  };

  type TracedIpcMain = typeof ipcMain & {
    __adeTraceWrapped?: boolean;
    __adeOriginalHandle?: typeof ipcMain.handle;
    __adeWindowScopeWrapped?: boolean;
    __adeWindowScopeOriginalHandle?: typeof ipcMain.handle;
  };

  const tracedIpcMain = ipcMain as TracedIpcMain;
  if (runWithIpcWindow && !tracedIpcMain.__adeWindowScopeWrapped) {
    const originalHandle = tracedIpcMain.handle.bind(ipcMain);
    tracedIpcMain.__adeWindowScopeOriginalHandle = originalHandle;
    tracedIpcMain.handle = ((channel, listener) =>
      originalHandle(channel, (event, ...args) =>
        runWithIpcWindow(event, () => listener(event, ...args))
      )) as typeof ipcMain.handle;
    tracedIpcMain.__adeWindowScopeWrapped = true;
  }

  type IpcInvokeAggregate = {
    channel: string;
    winId: number | null;
    count: number;
    failed: number;
    totalDurationMs: number;
    maxDurationMs: number;
    slowCount: number;
  };

  const IPC_SUMMARY_INTERVAL_MS = 10_000;
  const ipcInvokeAggregates = new Map<string, IpcInvokeAggregate>();
  let ipcInvokeSummaryTimer: NodeJS.Timeout | null = null;

  const flushIpcInvokeSummary = () => {
    ipcInvokeSummaryTimer = null;
    if (ipcInvokeAggregates.size === 0) return;
    const rows = [...ipcInvokeAggregates.values()];
    ipcInvokeAggregates.clear();
    const totalCalls = rows.reduce((sum, row) => sum + row.count, 0);
    const totalDurationMs = rows.reduce((sum, row) => sum + row.totalDurationMs, 0);
    const topByCount = [...rows]
      .sort((left, right) => right.count - left.count || right.totalDurationMs - left.totalDurationMs)
      .slice(0, 12)
      .map((row) => ({
        channel: row.channel,
        winId: row.winId,
        count: row.count,
        avgMs: Math.round(row.totalDurationMs / Math.max(1, row.count)),
        maxMs: row.maxDurationMs,
        slowCount: row.slowCount,
        failed: row.failed,
      }));
    const topByCost = [...rows]
      .sort((left, right) => right.totalDurationMs - left.totalDurationMs || right.count - left.count)
      .slice(0, 12)
      .map((row) => ({
        channel: row.channel,
        winId: row.winId,
        count: row.count,
        totalMs: row.totalDurationMs,
        avgMs: Math.round(row.totalDurationMs / Math.max(1, row.count)),
        maxMs: row.maxDurationMs,
        slowCount: row.slowCount,
        failed: row.failed,
      }));

    getTraceLogger().info("ipc.invoke.summary", {
      intervalMs: IPC_SUMMARY_INTERVAL_MS,
      totalCalls,
      totalDurationMs,
      topByCount,
      topByCost,
    });
  };

  const recordIpcInvokeAggregate = (input: {
    channel: string;
    winId: number | null;
    durationMs: number;
    failed: boolean;
  }) => {
    if (isPerfRunActive()) {
      try {
        perfAppend({
          ts: Date.now(),
          kind: "ipcInvoke",
          channel: input.channel,
          winId: input.winId,
          durationMs: input.durationMs,
          failed: input.failed,
        });
      } catch {
        // Perf telemetry is best-effort and must not change IPC behavior.
      }
    }
    if (!traceIpcInvokes) return;
    const key = `${input.winId ?? "none"}:${input.channel}`;
    const existing = ipcInvokeAggregates.get(key) ?? {
      channel: input.channel,
      winId: input.winId,
      count: 0,
      failed: 0,
      totalDurationMs: 0,
      maxDurationMs: 0,
      slowCount: 0,
    };
    existing.count += 1;
    existing.failed += input.failed ? 1 : 0;
    existing.totalDurationMs += input.durationMs;
    existing.maxDurationMs = Math.max(existing.maxDurationMs, input.durationMs);
    if (input.durationMs >= 120) existing.slowCount += 1;
    ipcInvokeAggregates.set(key, existing);

    if (!ipcInvokeSummaryTimer) {
      ipcInvokeSummaryTimer = setTimeout(flushIpcInvokeSummary, IPC_SUMMARY_INTERVAL_MS);
      ipcInvokeSummaryTimer.unref?.();
    }
  };

  if (!tracedIpcMain.__adeTraceWrapped) {
    const originalHandle = tracedIpcMain.handle.bind(ipcMain);
    tracedIpcMain.__adeOriginalHandle = originalHandle;
    tracedIpcMain.handle = ((channel, listener) =>
      originalHandle(channel, async (event, ...args) => {
        const callId = ++ipcInvokeSeq;
        const startedAt = Date.now();
        const winId = BrowserWindow.fromWebContents(event.sender)?.id ?? null;
        const traceLogger = traceIpcInvokes ? getTraceLogger() : null;
        if (traceEveryIpcInvoke) {
          traceLogger?.info("ipc.invoke.begin", {
            callId,
            channel,
            winId,
            projectRoot: (() => {
              try {
                return getCtx().project.rootPath;
              } catch {
                return null;
              }
            })(),
            args: summarizeIpcArgs(redactIpcArgsForChannel(channel, args)),
          });
        }
        const IPC_TIMEOUT_MS = ipcInvokeTimeoutMs(channel, args);
        let timeoutHandle: NodeJS.Timeout | null = null;
        let didTimeout = false;
        try {
          const result = await Promise.race([
            listener(event, ...args),
            new Promise<never>((_, reject) => {
              timeoutHandle = setTimeout(
                () => {
                  didTimeout = true;
                  reject(new Error(`IPC handler for '${channel}' timed out after ${IPC_TIMEOUT_MS}ms (callId=${callId})`));
                },
                IPC_TIMEOUT_MS,
              );
            }),
          ]);
          const durationMs = Date.now() - startedAt;
          recordIpcInvokeAggregate({ channel, winId, durationMs, failed: false });
          const usageAction = usageActionFromIpcChannel(channel);
          if (isMeaningfulUsageAction(usageAction)) {
            try {
              const ctx = getCtx();
              const payload = args.find((value) => value && typeof value === "object" && !Array.isArray(value)) as Record<string, unknown> | undefined;
              recordUsageInteraction(ctx.db, {
                projectId: ctx.projectId,
                client: "desktop",
                action: usageAction,
                sessionId: typeof payload?.sessionId === "string" ? payload.sessionId : null,
                analyticsEligible: productAnalyticsService?.getStatus().effective === true,
              });
            } catch {
              // Global/project-selection IPC can run without an active context.
            }
          }
          if (traceIpcInvokes && (traceEveryIpcInvoke || durationMs >= 120)) {
            traceLogger?.info("ipc.invoke.done", {
              callId,
              channel,
              winId,
              durationMs,
              result: summarizeIpcValue(redactIpcResultForChannel(channel, result)),
            });
          }
          return result;
        } catch (error) {
          const durationMs = Date.now() - startedAt;
          recordIpcInvokeAggregate({ channel, winId, durationMs, failed: true });
          const usageAction = usageActionFromIpcChannel(channel);
          if (isMeaningfulUsageAction(usageAction)) {
            const errorKind = error instanceof Error ? error.name : "unknown";
            try {
              productAnalyticsService?.capture({
                event: "ade_error",
                surface: "desktop",
                dedupeKey: `desktop-action-error:${usageAction}:${errorKind}`,
                minimumIntervalMs: 5 * 60_000,
                properties: {
                  action: usageAction,
                  feature: usageAction.split(".", 1)[0] ?? "other",
                  error_kind: errorKind,
                  outcome: didTimeout ? "timeout" : "failure",
                  recoverable: true,
                  source: "ipc",
                },
              });
            } catch {
              // Analytics capture must never mask the original IPC error.
            }
          }
          if (traceIpcInvokes || didTimeout) {
            const logger = traceLogger ?? getTraceLogger();
            logger.warn("ipc.invoke.failed", {
              callId,
              channel,
              winId,
              durationMs,
              err: getErrorMessage(error),
            });
          }
          throw error;
        } finally {
          if (timeoutHandle) clearTimeout(timeoutHandle);
        }
      })) as typeof ipcMain.handle;
    tracedIpcMain.__adeTraceWrapped = true;
  }

  const ensureComputerUseBroker = (): AppContextWith<"computerUseArtifactBrokerService"> => {
    const ctx = getCtx();
    requireAppContextServices(ctx, ["computerUseArtifactBrokerService"] as const);
    return ctx;
  };

  const ensureIosSimulator = (): NonNullable<AppContext["iosSimulatorService"]> => {
    const service = getCtx().iosSimulatorService;
    if (!service) {
      throw new Error("iOS Simulator service is not available.");
    }
    return service;
  };
  const readProjectRootArg = (arg: unknown): string | null => {
    if (!arg || typeof arg !== "object" || Array.isArray(arg)) return null;
    const value = (arg as { projectRoot?: unknown }).projectRoot;
    return typeof value === "string" && value.trim() ? value.trim() : null;
  };
  const isOptionalString = (value: unknown): value is string | null =>
    value === null || typeof value === "string";
  const isIosSimulatorToolStatus = (value: unknown): value is IosSimulatorToolStatus =>
    isRecord(value)
    && (value.name === "xcrun"
      || value.name === "xcodebuild"
      || value.name === "simulator_window"
      || value.name === "idb"
      || value.name === "idb_companion")
    && typeof value.available === "boolean"
    && typeof value.detail === "string"
    && typeof value.installHint === "string";
  const isIosSimulatorDevice = (value: unknown): value is IosSimulatorDevice =>
    isRecord(value)
    && typeof value.udid === "string"
    && typeof value.name === "string"
    && typeof value.runtime === "string"
    && typeof value.state === "string"
    && typeof value.isAvailable === "boolean";
  const isIosSimulatorSession = (value: unknown): value is IosSimulatorSession =>
    isRecord(value)
    && typeof value.id === "string"
    && typeof value.deviceUdid === "string"
    && isOptionalString(value.deviceName)
    && typeof value.bundleId === "string"
    && isOptionalString(value.appName)
    && isOptionalString(value.appBundlePath)
    && isOptionalString(value.targetId)
    && isOptionalString(value.projectRoot)
    && isOptionalString(value.laneId)
    && isOptionalString(value.chatSessionId)
    && (value.mode === "snapshot" || value.mode === "live")
    && (value.keepSimulatorInBackground === undefined
      || value.keepSimulatorInBackground === null
      || typeof value.keepSimulatorInBackground === "boolean")
    && isOptionalString(value.bridgeUrl)
    && typeof value.startedAt === "string"
    && isOptionalString(value.claimedAt);
  const normalizeIosSimulatorStatus = (value: unknown): IosSimulatorStatus | null => {
    if (!isRecord(value)) return null;
    const activeDevice = value.activeDevice;
    const activeSession = value.activeSession;
    if (
      typeof value.platform !== "string"
      || typeof value.supported !== "boolean"
      || !Array.isArray(value.tools)
      || !value.tools.every(isIosSimulatorToolStatus)
      || (activeDevice !== null && !isIosSimulatorDevice(activeDevice))
      || (activeSession !== null && !isIosSimulatorSession(activeSession))
    ) {
      return null;
    }
    return {
      platform: value.platform as NodeJS.Platform,
      supported: value.supported,
      tools: value.tools,
      activeDevice,
      activeSession,
    };
  };
  const getIosSimulatorContextForEvent = (event: IpcMainInvokeEvent, arg?: unknown): AppContext | null => {
    const windowId = BrowserWindow.fromWebContents(event.sender)?.id ?? null;
    const session = getWindowSession?.(windowId) ?? null;
    const boundLocalRoot = session?.binding?.kind === "local"
      ? session.binding.rootPath
      : null;
    const explicitRoot = readProjectRootArg(arg);
    const resolveProjectContext = (projectRoot: string) =>
      getProjectContext ? getProjectContext(projectRoot) ?? null : getCtx();
    if (explicitRoot) {
      if (!boundLocalRoot || explicitRoot !== boundLocalRoot) {
        throw new Error("iOS Simulator access is only allowed for the window's bound local project.");
      }
      return resolveProjectContext(explicitRoot);
    }
    const sessionRoot = boundLocalRoot ?? session?.project?.rootPath ?? null;
    if (sessionRoot) return resolveProjectContext(sessionRoot);
    return getWindowSession ? null : getCtx();
  };
  const throwIosSimulatorUnavailableForEvent = (ctx: AppContext | null, arg?: unknown, channel = IPC.iosSimulatorListWindowSources): never => {
    const requestedProjectRoot = readProjectRootArg(arg);
    const projectRoot = requestedProjectRoot ?? ctx?.project?.rootPath ?? null;
    const logger = ctx?.logger ?? getCtx().logger;
    logger.warn("ios_simulator.service_unavailable", {
      channel,
      requestedProjectRoot,
      contextProjectRoot: ctx?.project?.rootPath ?? null,
      hasUserSelectedProject: ctx?.hasUserSelectedProject ?? false,
    });
    throw new Error(
      projectRoot
        ? `iOS Simulator service is not available for ${projectRoot}.`
        : "iOS Simulator service is not available because no local project is bound to this window.",
    );
  };
  const getIosSimulatorStatusForEvent = async (
    event: IpcMainInvokeEvent,
    arg?: unknown,
    channel = IPC.iosSimulatorListWindowSources,
  ): Promise<IosSimulatorStatus> => {
    const ctx = getIosSimulatorContextForEvent(event, arg);
    const service = ctx?.iosSimulatorService;
    if (service) {
      const status = normalizeIosSimulatorStatus(await service.getStatus());
      if (status) return status;
    }

    const runtimeStatus = await tryLocalRuntimeSync(event, async (pool, rootPath) => {
      const response = await pool.callActionForRoot(rootPath, {
        domain: "ios_simulator",
        action: "getStatus",
        args: {},
      });
      return normalizeIosSimulatorStatus(response.result);
    });
    if (runtimeStatus) return runtimeStatus;
    return throwIosSimulatorUnavailableForEvent(ctx, arg, channel);
  };

  const ensureAppControl = (): NonNullable<AppContext["appControlService"]> => {
    const service = getCtx().appControlService;
    if (!service) {
      throw new Error("App Control service is not available.");
    }
    return service;
  };

  const ensureBuiltInBrowser = (): ReturnType<typeof createBuiltInBrowserService> => {
    if (!builtInBrowserService) {
      throw new Error("Built-in browser service is not available.");
    }
    return builtInBrowserService;
  };

  const isTrustedAppControlRendererUrl = (rawUrl: string | null | undefined): boolean => {
    if (!rawUrl) return false;
    try {
      const url = new URL(rawUrl);
      const devServerUrl = process.env.VITE_DEV_SERVER_URL;
      if (devServerUrl) {
        return url.origin === new URL(devServerUrl).origin;
      }
      return url.protocol === "file:" && /\/renderer\/index\.html$/.test(decodeURIComponent(url.pathname));
    } catch {
      return false;
    }
  };

  const assertTrustedAppControlSender = (event: IpcMainInvokeEvent, channel: string): void => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const senderUrl = event.senderFrame?.url || event.sender.getURL();
    if (win && !win.isDestroyed() && isTrustedAppControlRendererUrl(senderUrl)) return;
    getCtx().logger.warn("ipc.app_control.untrusted_sender", {
      channel,
      windowId: win?.id ?? null,
      senderUrl: senderUrl || null,
    });
    throw new Error("App Control is only available to the ADE renderer.");
  };

  const assertAppControlRateLimit = (
    event: IpcMainInvokeEvent,
    channel: string,
    limit: { windowMs: number; max: number },
  ): void => {
    const now = Date.now();
    const key = `${event.sender.id}:${channel}`;
    // Cheap sweep: prune entries whose window has fully expired so the map
    // does not grow unboundedly across cycling sender/window IDs.
    for (const [k, v] of appControlRateBuckets) {
      if (now - v.windowStartMs > limit.windowMs) {
        appControlRateBuckets.delete(k);
      }
    }
    const bucket = appControlRateBuckets.get(key);
    if (!bucket || now - bucket.windowStartMs > limit.windowMs) {
      appControlRateBuckets.set(key, { windowStartMs: now, count: 1 });
      return;
    }
    if (bucket.count >= limit.max) {
      const win = BrowserWindow.fromWebContents(event.sender);
      getCtx().logger.warn("ipc.app_control.rate_limited", {
        channel,
        windowId: win?.id ?? null,
        count: bucket.count,
        windowMs: limit.windowMs,
      });
      throw new Error("Too many App Control requests. Try again shortly.");
    }
    bucket.count += 1;
  };

  const guardAppControlIpc = (
    event: IpcMainInvokeEvent,
    channel: string,
    limit: { windowMs: number; max: number } = { windowMs: 10_000, max: 40 },
  ): void => {
    assertTrustedAppControlSender(event, channel);
    assertAppControlRateLimit(event, channel, limit);
  };

  const assertTrustedFilesSender = (event: IpcMainInvokeEvent, channel: string): void => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const senderUrl = event.senderFrame?.url || event.sender.getURL();
    if (win && !win.isDestroyed() && isTrustedAppControlRendererUrl(senderUrl)) return;
    getCtx().logger.warn("ipc.files.untrusted_sender", {
      channel,
      windowId: win?.id ?? null,
      senderUrl: senderUrl || null,
    });
    throw new Error("Files access is only available to the ADE renderer.");
  };

  const assertBuiltInBrowserRateLimit = (
    event: IpcMainInvokeEvent,
    channel: string,
    limit: { windowMs: number; max: number },
  ): void => {
    const now = Date.now();
    const key = `${event.sender.id}:${channel}`;
    for (const [k, v] of builtInBrowserRateBuckets) {
      if (now - v.windowStartMs > limit.windowMs) {
        builtInBrowserRateBuckets.delete(k);
      }
    }
    const bucket = builtInBrowserRateBuckets.get(key);
    if (!bucket || now - bucket.windowStartMs > limit.windowMs) {
      builtInBrowserRateBuckets.set(key, { windowStartMs: now, count: 1 });
      return;
    }
    if (bucket.count >= limit.max) {
      const win = BrowserWindow.fromWebContents(event.sender);
      getCtx().logger.warn("ipc.built_in_browser.rate_limited", {
        channel,
        windowId: win?.id ?? null,
        count: bucket.count,
        windowMs: limit.windowMs,
      });
      throw new Error("Too many browser requests. Try again shortly.");
    }
    bucket.count += 1;
  };

  const guardBuiltInBrowserIpc = (
    event: IpcMainInvokeEvent,
    channel: string,
    limit: { windowMs: number; max: number } = { windowMs: 10_000, max: 60 },
  ): BrowserWindow => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const senderUrl = event.senderFrame?.url || event.sender.getURL();
    if (!win || win.isDestroyed() || !isTrustedAppControlRendererUrl(senderUrl)) {
      getCtx().logger.warn("ipc.built_in_browser.untrusted_sender", {
        channel,
        windowId: win?.id ?? null,
        senderUrl: senderUrl || null,
      });
      throw new Error("Built-in browser is only available to the ADE renderer.");
    }
    assertBuiltInBrowserRateLimit(event, channel, limit);
    return win;
  };

  const invalidBuiltInBrowserArg = (channel: string, reason: string): never => {
    getCtx().logger.warn("ipc.built_in_browser.invalid_args", { channel, reason });
    throw new Error(`Invalid built-in browser payload: ${reason}`);
  };

  const builtInBrowserRecord = (value: unknown, channel: string, required = false): Record<string, unknown> => {
    if (value == null) {
      if (required) invalidBuiltInBrowserArg(channel, "payload object is required");
      return {};
    }
    if (!isRecord(value)) invalidBuiltInBrowserArg(channel, "payload must be an object");
    return value as Record<string, unknown>;
  };

  const builtInBrowserNumber = (
    record: Record<string, unknown>,
    field: string,
    channel: string,
    options: { min?: number; max?: number } = {},
  ): number => {
    const value = record[field];
    if (typeof value !== "number" || !Number.isFinite(value)) {
      invalidBuiltInBrowserArg(channel, `${field} must be a finite number`);
    }
    const numberValue = value as number;
    if (options.min != null && numberValue < options.min) invalidBuiltInBrowserArg(channel, `${field} is below the minimum`);
    if (options.max != null && numberValue > options.max) invalidBuiltInBrowserArg(channel, `${field} is above the maximum`);
    return numberValue;
  };

  const parseBuiltInBrowserBoundsArgs = (value: unknown, channel: string): BuiltInBrowserBoundsArgs => {
    const record = builtInBrowserRecord(value, channel, true);
    const visibleValue = record.visible;
    if (typeof visibleValue !== "boolean") invalidBuiltInBrowserArg(channel, "visible must be a boolean");
    return {
      ...parseBuiltInBrowserProjectScopeArgs(record, channel),
      x: builtInBrowserNumber(record, "x", channel, { min: 0, max: 100_000 }),
      y: builtInBrowserNumber(record, "y", channel, { min: 0, max: 100_000 }),
      width: builtInBrowserNumber(record, "width", channel, { min: 0, max: 100_000 }),
      height: builtInBrowserNumber(record, "height", channel, { min: 0, max: 100_000 }),
      visible: visibleValue as boolean,
    };
  };

  const parseBuiltInBrowserAttachWebviewArgs = (value: unknown, channel: string): BuiltInBrowserAttachWebviewArgs => {
    const record = builtInBrowserRecord(value, channel, true);
    const webContentsId = builtInBrowserNumber(record, "webContentsId", channel, { min: 1, max: Number.MAX_SAFE_INTEGER });
    const tabId = optionalBuiltInBrowserString(record, "tabId", channel, 128);
    if (!tabId) return invalidBuiltInBrowserArg(channel, "tabId must be a non-empty string");
    return { ...parseBuiltInBrowserProjectScopeArgs(record, channel), tabId, webContentsId };
  };

  const parseBuiltInBrowserNavigateArgs = (value: unknown, channel: string): BuiltInBrowserNavigateArgs => {
    const record = builtInBrowserRecord(value, channel, true);
    const urlValue = record.url;
    if (typeof urlValue !== "string" || !urlValue.trim()) {
      invalidBuiltInBrowserArg(channel, "url must be a non-empty string");
    }
    const url = urlValue as string;
    if (url.length > 4096 || url.includes("\0")) {
      invalidBuiltInBrowserArg(channel, "url is invalid");
    }
    const tabId = optionalBuiltInBrowserString(record, "tabId", channel, 128);
    const newTab = record.newTab === true ? true : undefined;
    const openPanel = optionalBoolean(record.openPanel);
    return { url, tabId, newTab, openPanel, ...parseBuiltInBrowserClaimArgs(record, channel) };
  };

  function optionalBuiltInBrowserString(
    record: Record<string, unknown>,
    field: string,
    channel: string,
    maxLength: number,
  ): string | null | undefined {
    const value = record[field];
    if (value == null) return undefined;
    if (typeof value !== "string") return invalidBuiltInBrowserArg(channel, `${field} must be a string`);
    const trimmed = value.trim();
    if (!trimmed.length) return null;
    if (trimmed.length > maxLength || trimmed.includes("\0")) return invalidBuiltInBrowserArg(channel, `${field} is invalid`);
    return trimmed;
  }

  function optionalBoolean(value: unknown): boolean | undefined {
    if (value === true) return true;
    if (value === false) return false;
    return undefined;
  }

  function optionalBuiltInBrowserNumber(
    record: Record<string, unknown>,
    field: string,
    channel: string,
    options: { min?: number; max?: number } = {},
  ): number | undefined {
    if (record[field] == null) return undefined;
    return builtInBrowserNumber(record, field, channel, options);
  }

  const parseBuiltInBrowserProjectScopeArgs = (
    record: Record<string, unknown>,
    channel: string,
  ): BuiltInBrowserProjectScopeArgs => {
    const projectRoot = optionalBuiltInBrowserString(record, "projectRoot", channel, 4096);
    const tabCollection = optionalBuiltInBrowserString(record, "tabCollection", channel, 16);
    if (tabCollection && tabCollection !== "personal") {
      return invalidBuiltInBrowserArg(channel, "tabCollection is invalid");
    }
    if (tabCollection === "personal" && projectRoot) {
      return invalidBuiltInBrowserArg(channel, "tabCollection and projectRoot cannot both be set");
    }
    return {
      ...(projectRoot ? { projectRoot } : {}),
      ...(tabCollection === "personal" ? { tabCollection } : {}),
    };
  };

  const parseBuiltInBrowserProjectScopeInput = (
    value: unknown,
    channel: string,
  ): BuiltInBrowserProjectScopeArgs =>
    parseBuiltInBrowserProjectScopeArgs(builtInBrowserRecord(value, channel, false), channel);

  const parseBuiltInBrowserClearPermissionsArgs = (
    value: unknown,
    channel: string,
  ): BuiltInBrowserClearPermissionsArgs => {
    const record = builtInBrowserRecord(value, channel, false);
    const origin = optionalBuiltInBrowserString(record, "origin", channel, 2048);
    const permission = optionalBuiltInBrowserString(record, "permission", channel, 128);
    return {
      ...(origin ? { origin } : {}),
      ...(permission ? { permission } : {}),
    };
  };

  const parseBuiltInBrowserClaimArgs = (record: Record<string, unknown>, channel: string): BuiltInBrowserClaimArgs => {
    const tabId = optionalBuiltInBrowserString(record, "tabId", channel, 128);
    const laneId = optionalBuiltInBrowserString(record, "laneId", channel, 128);
    const chatSessionId = optionalBuiltInBrowserString(record, "chatSessionId", channel, 128);
    const force = optionalBoolean(record.force);
    const leaseTtlMs = optionalBuiltInBrowserNumber(record, "leaseTtlMs", channel, {
      min: 1_000,
      max: 60 * 60_000,
    });
    return {
      ...parseBuiltInBrowserProjectScopeArgs(record, channel),
      ...(tabId ? { tabId } : {}),
      ...(laneId ? { laneId } : {}),
      ...(chatSessionId ? { chatSessionId } : {}),
      ...(force !== undefined ? { force } : {}),
      ...(leaseTtlMs !== undefined ? { leaseTtlMs } : {}),
    };
  };

  const parseBuiltInBrowserTabTargetRecord = (
    record: Record<string, unknown>,
    channel: string,
  ): BuiltInBrowserTabTargetArgs => {
    const sessionId = optionalBuiltInBrowserString(record, "sessionId", channel, 128);
    return {
      ...parseBuiltInBrowserClaimArgs(record, channel),
      ...(sessionId ? { sessionId } : {}),
    };
  };

  const parseBuiltInBrowserTabTargetArgs = (value: unknown, channel: string): BuiltInBrowserTabTargetArgs => {
    const record = builtInBrowserRecord(value, channel, false);
    return parseBuiltInBrowserTabTargetRecord(record, channel);
  };

  const parseBuiltInBrowserTabArgs = (value: unknown, channel: string): BuiltInBrowserTabArgs => {
    const record = builtInBrowserRecord(value, channel, true);
    const tabId = optionalBuiltInBrowserString(record, "tabId", channel, 128);
    if (!tabId) return invalidBuiltInBrowserArg(channel, "tabId must be a non-empty string");
    const openPanel = optionalBoolean(record.openPanel);
    return { ...parseBuiltInBrowserClaimArgs(record, channel), tabId, openPanel };
  };

  const parseBuiltInBrowserCreateTabArgs = (value: unknown, channel: string): BuiltInBrowserCreateTabArgs => {
    const record = builtInBrowserRecord(value, channel, false);
    const url = optionalBuiltInBrowserString(record, "url", channel, 4096);
    const activate = record.activate === false ? false : undefined;
    const openPanel = optionalBoolean(record.openPanel);
    return { url, activate, openPanel, ...parseBuiltInBrowserClaimArgs(record, channel) };
  };

  const parseBuiltInBrowserOpenPanelArgs = (value: unknown, channel: string): BuiltInBrowserOpenPanelArgs => {
    const record = builtInBrowserRecord(value, channel, false);
    const url = optionalBuiltInBrowserString(record, "url", channel, 4096);
    const tabId = optionalBuiltInBrowserString(record, "tabId", channel, 128);
    return { url, tabId, ...parseBuiltInBrowserClaimArgs(record, channel) };
  };

  const parseBuiltInBrowserSelectPointArgs = (value: unknown, channel: string): BuiltInBrowserSelectPointArgs => {
    const record = builtInBrowserRecord(value, channel, true);
    const includeScreenshot = record.includeScreenshot === false ? false : undefined;
    return {
      ...parseBuiltInBrowserTabTargetRecord(record, channel),
      x: builtInBrowserNumber(record, "x", channel, { min: 0, max: 100_000 }),
      y: builtInBrowserNumber(record, "y", channel, { min: 0, max: 100_000 }),
      includeScreenshot,
    };
  };

  const invalidAppControlArg = (channel: string, reason: string): never => {
    getCtx().logger.warn("ipc.app_control.invalid_args", { channel, reason });
    throw new Error(`Invalid App Control payload: ${reason}`);
  };

  const appControlRecord = (value: unknown, channel: string, required = false): Record<string, unknown> => {
    if (value == null) {
      if (required) invalidAppControlArg(channel, "payload object is required");
      return {};
    }
    if (!isRecord(value)) invalidAppControlArg(channel, "payload must be an object");
    return value as Record<string, unknown>;
  };

  const optionalAppControlString = (
    record: Record<string, unknown>,
    field: string,
    channel: string,
    maxLength: number,
    options: { trim?: boolean } = {},
  ): string | null | undefined => {
    const value = record[field];
    if (value === undefined) return undefined;
    if (value === null) return null;
    if (typeof value !== "string") invalidAppControlArg(channel, `${field} must be a string`);
    const stringValue = value as string;
    if (stringValue.includes("\0")) invalidAppControlArg(channel, `${field} cannot contain null bytes`);
    const normalized = options.trim === false ? stringValue : stringValue.trim();
    if (normalized.length > maxLength) invalidAppControlArg(channel, `${field} is too long`);
    return normalized;
  };

  const optionalAppControlBoolean = (
    record: Record<string, unknown>,
    field: string,
    channel: string,
  ): boolean | null | undefined => {
    const value = record[field];
    if (value === undefined) return undefined;
    if (value === null) return null;
    if (typeof value !== "boolean") invalidAppControlArg(channel, `${field} must be a boolean`);
    return value as boolean;
  };

  const optionalAppControlNumber = (
    record: Record<string, unknown>,
    field: string,
    channel: string,
    options: { integer?: boolean; min?: number; max?: number } = {},
  ): number | null | undefined => {
    const value = record[field];
    if (value === undefined) return undefined;
    if (value === null) return null;
    if (typeof value !== "number" || !Number.isFinite(value)) {
      invalidAppControlArg(channel, `${field} must be a finite number`);
    }
    const numberValue = value as number;
    if (options.integer && !Number.isInteger(numberValue)) invalidAppControlArg(channel, `${field} must be an integer`);
    if (options.min != null && numberValue < options.min) invalidAppControlArg(channel, `${field} is below the minimum`);
    if (options.max != null && numberValue > options.max) invalidAppControlArg(channel, `${field} is above the maximum`);
    return numberValue;
  };

  const optionalAppControlAppKind = (
    record: Record<string, unknown>,
    channel: string,
  ): AppControlLaunchArgs["appKind"] | undefined => {
    const value = record.appKind;
    if (value === undefined) return undefined;
    if (value === null) return null;
    if (value !== "electron") invalidAppControlArg(channel, "appKind must be electron");
    return value as "electron";
  };

  const optionalAppControlCoordinateSpace = (
    record: Record<string, unknown>,
    channel: string,
  ): AppControlCoordinateSpace | null | undefined => {
    const value = record.coordinateSpace;
    if (value === undefined) return undefined;
    if (value === null) return null;
    if (value !== "screenshot" && value !== "viewport") {
      invalidAppControlArg(channel, "coordinateSpace must be screenshot or viewport");
    }
    return value as AppControlCoordinateSpace;
  };

  const optionalAppControlEnv = (
    record: Record<string, unknown>,
    channel: string,
  ): AppControlLaunchArgs["env"] | undefined => {
    const value = record.env;
    if (value === undefined) return undefined;
    if (value === null) return null;
    if (!isRecord(value)) invalidAppControlArg(channel, "env must be an object");
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length > 64) invalidAppControlArg(channel, "env has too many entries");
    const env: NonNullable<AppControlLaunchArgs["env"]> = {};
    for (const [key, envValue] of entries) {
      if (!key || key.length > 128 || key.includes("=") || key.includes("\0")) {
        invalidAppControlArg(channel, `env key ${JSON.stringify(key)} is invalid`);
      }
      if (envValue === undefined) continue;
      if (envValue === null) {
        env[key] = null;
        continue;
      }
      if (typeof envValue !== "string") invalidAppControlArg(channel, `env.${key} must be a string`);
      const stringEnvValue = envValue as string;
      if (stringEnvValue.includes("\0")) invalidAppControlArg(channel, `env.${key} cannot contain null bytes`);
      if (stringEnvValue.length > 8192) invalidAppControlArg(channel, `env.${key} is too long`);
      env[key] = stringEnvValue;
    }
    return env;
  };

  const parseAppControlLaunchArgs = (value: unknown, channel: string): AppControlLaunchArgs => {
    const record = appControlRecord(value, channel);
    const args: AppControlLaunchArgs = {};
    const appKind = optionalAppControlAppKind(record, channel);
    if (appKind !== undefined) args.appKind = appKind;
    const projectRoot = optionalAppControlString(record, "projectRoot", channel, 4096);
    if (projectRoot !== undefined) args.projectRoot = projectRoot;
    const laneId = optionalAppControlString(record, "laneId", channel, 512);
    if (laneId !== undefined) args.laneId = laneId;
    const command = optionalAppControlString(record, "command", channel, 8000);
    if (command !== undefined) args.command = command;
    const cwd = optionalAppControlString(record, "cwd", channel, 4096);
    if (cwd !== undefined) args.cwd = cwd;
    const cdpPort = optionalAppControlNumber(record, "cdpPort", channel, { integer: true, min: 1, max: 65535 });
    if (cdpPort !== undefined) args.cdpPort = cdpPort;
    const debugPort = optionalAppControlNumber(record, "debugPort", channel, { integer: true, min: 1, max: 65535 });
    if (debugPort !== undefined) args.debugPort = debugPort;
    const env = optionalAppControlEnv(record, channel);
    if (env !== undefined) args.env = env;
    const label = optionalAppControlString(record, "label", channel, 256);
    if (label !== undefined) args.label = label;
    const chatSessionId = optionalAppControlString(record, "chatSessionId", channel, 128);
    if (chatSessionId !== undefined) args.chatSessionId = chatSessionId;
    const force = optionalAppControlBoolean(record, "force", channel);
    if (force !== undefined) args.force = force;
    return args;
  };

  const parseAppControlConnectArgs = (value: unknown, channel: string): AppControlConnectArgs => {
    const record = appControlRecord(value, channel, true);
    const cdpPort = optionalAppControlNumber(record, "cdpPort", channel, { integer: true, min: 1, max: 65535 });
    if (cdpPort == null) invalidAppControlArg(channel, "cdpPort is required");
    const args: AppControlConnectArgs = { cdpPort: cdpPort as number };
    const appKind = optionalAppControlAppKind(record, channel);
    if (appKind !== undefined) args.appKind = appKind;
    const projectRoot = optionalAppControlString(record, "projectRoot", channel, 4096);
    if (projectRoot !== undefined) args.projectRoot = projectRoot;
    const laneId = optionalAppControlString(record, "laneId", channel, 512);
    if (laneId !== undefined) args.laneId = laneId;
    const label = optionalAppControlString(record, "label", channel, 256);
    if (label !== undefined) args.label = label;
    const chatSessionId = optionalAppControlString(record, "chatSessionId", channel, 128);
    if (chatSessionId !== undefined) args.chatSessionId = chatSessionId;
    const force = optionalAppControlBoolean(record, "force", channel);
    if (force !== undefined) args.force = force;
    return args;
  };

  const parseAppControlStopArgs = (value: unknown, channel: string): AppControlStopArgs => {
    const record = appControlRecord(value, channel);
    const args: AppControlStopArgs = {};
    const force = optionalAppControlBoolean(record, "force", channel);
    if (force !== undefined) args.force = force;
    return args;
  };

  const parseAppControlSnapshotArgs = (value: unknown, channel: string): AppControlSnapshotArgs => {
    const record = appControlRecord(value, channel);
    const args: AppControlSnapshotArgs = {};
    const projectRoot = optionalAppControlString(record, "projectRoot", channel, 4096);
    if (projectRoot !== undefined) args.projectRoot = projectRoot;
    const x = optionalAppControlNumber(record, "x", channel, { min: 0, max: 100_000 });
    if (x !== undefined) args.x = x;
    const y = optionalAppControlNumber(record, "y", channel, { min: 0, max: 100_000 });
    if (y !== undefined) args.y = y;
    const coordinateSpace = optionalAppControlCoordinateSpace(record, channel);
    if (coordinateSpace !== undefined) args.coordinateSpace = coordinateSpace;
    return args;
  };

  const parseAppControlPointArgs = (value: unknown, channel: string): AppControlInspectPointArgs => {
    const record = appControlRecord(value, channel, true);
    const x = optionalAppControlNumber(record, "x", channel, { min: 0, max: 100_000 });
    const y = optionalAppControlNumber(record, "y", channel, { min: 0, max: 100_000 });
    if (x == null || y == null) invalidAppControlArg(channel, "x and y are required");
    const args: AppControlInspectPointArgs = { x: x as number, y: y as number };
    const scale = optionalAppControlNumber(record, "scale", channel, { min: 0.01, max: 100 });
    if (scale !== undefined) args.scale = scale;
    const coordinateSpace = optionalAppControlCoordinateSpace(record, channel);
    if (coordinateSpace !== undefined) args.coordinateSpace = coordinateSpace;
    const projectRoot = optionalAppControlString(record, "projectRoot", channel, 4096);
    if (projectRoot !== undefined) args.projectRoot = projectRoot;
    const includeScreenshot = optionalAppControlBoolean(record, "includeScreenshot", channel);
    if (includeScreenshot !== undefined) args.includeScreenshot = includeScreenshot;
    return args;
  };

  const parseAppControlClickArgs = (value: unknown, channel: string): AppControlClickArgs => {
    const record = appControlRecord(value, channel, true);
    const x = optionalAppControlNumber(record, "x", channel, { min: 0, max: 100_000 });
    const y = optionalAppControlNumber(record, "y", channel, { min: 0, max: 100_000 });
    if (x == null || y == null) invalidAppControlArg(channel, "x and y are required");
    const scale = optionalAppControlNumber(record, "scale", channel, { min: 0.01, max: 100 });
    const coordinateSpace = optionalAppControlCoordinateSpace(record, channel);
    return {
      x: x as number,
      y: y as number,
      ...(scale !== undefined ? { scale } : {}),
      ...(coordinateSpace !== undefined ? { coordinateSpace } : {}),
    };
  };

  const parseAppControlTypeTextArgs = (value: unknown, channel: string): AppControlTypeTextArgs => {
    const record = appControlRecord(value, channel, true);
    const text = optionalAppControlString(record, "text", channel, 10_000, { trim: false });
    if (text == null) invalidAppControlArg(channel, "text is required");
    return { text: text as string };
  };

  const terminalRecord = (value: unknown): Record<string, unknown> => (isRecord(value) ? value as Record<string, unknown> : {});

  const optionalTerminalString = (
    record: Record<string, unknown>,
    field: string,
    maxLength = 4096,
    trim = true,
  ): string | null | undefined => {
    const value = record[field];
    if (value === undefined) return undefined;
    if (value === null) return null;
    if (typeof value !== "string") throw new Error(`Invalid terminal payload: ${field} must be a string`);
    const text = trim ? value.trim() : value;
    if (text.includes("\0")) throw new Error(`Invalid terminal payload: ${field} cannot contain null bytes`);
    if (text.length > maxLength) throw new Error(`Invalid terminal payload: ${field} is too long`);
    return text;
  };

  const optionalTerminalNumber = (
    record: Record<string, unknown>,
    field: string,
    min: number,
    max: number,
  ): number | null | undefined => {
    const value = record[field];
    if (value === undefined) return undefined;
    if (value === null) return null;
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new Error(`Invalid terminal payload: ${field} must be a finite number`);
    }
    const next = Math.floor(value);
    if (next < min || next > max) throw new Error(`Invalid terminal payload: ${field} is out of range`);
    return next;
  };

  const parseTerminalListArgs = (value: unknown): ChatTerminalListArgs => {
    const record = terminalRecord(value);
    return {
      chatSessionId: optionalTerminalString(record, "chatSessionId", 128),
      laneId: optionalTerminalString(record, "laneId", 512),
      limit: optionalTerminalNumber(record, "limit", 1, 500),
    };
  };

  const parseTerminalReadArgs = (value: unknown): ChatTerminalReadArgs => {
    const record = terminalRecord(value);
    return {
      terminalId: optionalTerminalString(record, "terminalId", 128),
      ptyId: optionalTerminalString(record, "ptyId", 128),
      chatSessionId: optionalTerminalString(record, "chatSessionId", 128),
      maxBytes: optionalTerminalNumber(record, "maxBytes", 1, 8 * 1024 * 1024),
      since: optionalTerminalNumber(record, "since", 0, 8 * 1024 * 1024),
    };
  };

  const parseTerminalPreviewArgs = (value: unknown): ChatTerminalPreviewArgs => {
    const record = terminalRecord(value);
    return {
      terminalId: optionalTerminalString(record, "terminalId", 128),
      chatSessionId: optionalTerminalString(record, "chatSessionId", 128),
      maxBytes: optionalTerminalNumber(record, "maxBytes", 1, 8 * 1024 * 1024),
    };
  };

  const parseTerminalWriteArgs = (value: unknown): ChatTerminalWriteArgs => {
    const record = terminalRecord(value);
    const data = optionalTerminalString(record, "data", 100_000, false);
    if (data == null) throw new Error("Invalid terminal payload: data is required");
    return {
      terminalId: optionalTerminalString(record, "terminalId", 128),
      ptyId: optionalTerminalString(record, "ptyId", 128),
      chatSessionId: optionalTerminalString(record, "chatSessionId", 128),
      data,
    };
  };

  const parseTerminalSignalArgs = (value: unknown): ChatTerminalSignalArgs => {
    const record = terminalRecord(value);
    const signal = optionalTerminalString(record, "signal", 16);
    if (signal !== "SIGINT" && signal !== "SIGTERM" && signal !== "SIGKILL") {
      throw new Error("Invalid terminal payload: signal must be SIGINT, SIGTERM, or SIGKILL");
    }
    return {
      terminalId: optionalTerminalString(record, "terminalId", 128),
      ptyId: optionalTerminalString(record, "ptyId", 128),
      chatSessionId: optionalTerminalString(record, "chatSessionId", 128),
      signal,
    };
  };

  const parseTerminalActiveForChatArgs = (value: unknown): ChatTerminalActiveForChatArgs => {
    const record = terminalRecord(value);
    const chatSessionId = optionalTerminalString(record, "chatSessionId", 128);
    if (!chatSessionId) throw new Error("Invalid terminal payload: chatSessionId is required");
    return { chatSessionId };
  };

  const parseTerminalReattachArgs = (value: unknown): ChatTerminalReattachArgs => {
    const record = terminalRecord(value);
    const chatSessionId = optionalTerminalString(record, "chatSessionId", 128);
    if (!chatSessionId) throw new Error("Invalid terminal payload: chatSessionId is required");
    const rawCols = record["cols"];
    const rawRows = record["rows"];
    const cols = typeof rawCols === "number" && Number.isFinite(rawCols) ? rawCols : null;
    const rows = typeof rawRows === "number" && Number.isFinite(rawRows) ? rawRows : null;
    return { chatSessionId, cols, rows };
  };

  const resolveComputerUseOwnerSnapshotArgs = async (
    _ctx: AppContext,
    args: ComputerUseOwnerSnapshotArgs,
  ): Promise<ComputerUseOwnerSnapshotArgs> => args;

  type PrAiRuntimeSession = {
    sessionId: string;
    ptyId: string | null;
    runId: string;
    provider: "codex" | "claude";
    contextKey: string;
    context: PrAiResolutionContext;
    modelId: string;
    reasoning: string | null;
    permissionMode: PrAgentPermissionMode;
    pollTimer: ReturnType<typeof setInterval> | null;
    finalizing: boolean;
  };

  const prAiSessions = new Map<string, PrAiRuntimeSession>();
  const prAiSessionsByContextKey = new Map<string, string>();

  const emitPrAiResolutionEvent = (payload: PrAiResolutionEventPayload): void => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isDestroyed()) continue;
      try {
        win.webContents.send(IPC.prsAiResolutionEvent, payload);
      } catch {
        // ignore broadcast failures
      }
    }
  };

  const clearPrAiSession = (sessionId: string): void => {
    const runtime = prAiSessions.get(sessionId);
    if (!runtime) return;
    if (runtime.pollTimer) {
      clearInterval(runtime.pollTimer);
    }
    if (prAiSessionsByContextKey.get(runtime.contextKey) === sessionId) {
      prAiSessionsByContextKey.delete(runtime.contextKey);
    }
    prAiSessions.delete(sessionId);
  };

  const finalizePrAiSession = async (
    sessionId: string,
    opts: { forceStatus?: "cancelled" | "completed" | "failed"; message?: string } = {}
  ): Promise<void> => {
    const runtime = prAiSessions.get(sessionId);
    if (!runtime || runtime.finalizing) return;
    runtime.finalizing = true;
    const ctx = getCtx();
    requireAppContextServices(ctx, ["sessionService", "conflictService"] as const);
    try {
      const detail = ctx.sessionService.get(sessionId);
      const derivedExitCode = opts.forceStatus === "cancelled"
        ? 130
        : (detail?.exitCode ?? (detail?.status === "completed" ? 0 : 1));
      try {
        await ctx.conflictService.finalizeResolverSession({
          runId: runtime.runId,
          exitCode: derivedExitCode
        });
      } catch (error) {
        ctx.logger.debug("ipc.prs_ai_resolution_finalize_failed", {
          sessionId,
          runId: runtime.runId,
          error: getErrorMessage(error)
        });
      }

      const status = opts.forceStatus
        ?? (detail?.status === "disposed"
          ? "cancelled"
          : derivedExitCode === 0
            ? "completed"
            : "failed");
      emitPrAiResolutionEvent({
        sessionId,
        status,
        message: opts.message ?? null,
        timestamp: nowIso()
      });
    } finally {
      clearPrAiSession(sessionId);
    }
  };

  const buildPrAiSessionInfo = (args: {
    context: PrAiResolutionContext;
    contextKey: string;
    sessionId: string;
    provider: "codex" | "claude";
    model: string | null;
    modelId: string | null;
    reasoning: string | null;
    permissionMode: PrAgentPermissionMode | null;
    status: PrAiResolutionSessionStatus;
  }): PrAiResolutionSessionInfo => ({
    contextKey: args.contextKey,
    sessionId: args.sessionId,
    provider: args.provider,
    model: args.model,
    modelId: args.modelId,
    reasoning: args.reasoning,
    permissionMode: args.permissionMode,
    context: args.context,
    status: args.status,
  });

  ipcMain.handle(IPC.appPing, async () => "pong" as const);

  ipcMain.handle(
    IPC.analyticsCapture,
    async (
      _event,
      input: unknown,
    ) => {
      if (!productAnalyticsService) return { accepted: false, reason: "not_configured" };
      const parsed = parseProductAnalyticsCapture(input, "desktop");
      if (!parsed.ok) return { accepted: false, reason: parsed.reason };
      const { projectId: _untrustedProjectId, dedupeKey, ...safeInput } = parsed.value;
      let projectId: string | null = null;
      try {
        projectId = getCtx().projectId;
      } catch {
        // Projectless desktop screens are still valid analytics events.
      }
      return productAnalyticsService.capture({
        ...safeInput,
        surface: "desktop",
        ...(projectId ? { projectId } : {}),
        ...(safeInput.event === "ade_project_opened" && projectId
          ? { dedupeKey: `desktop_project_opened:${projectId}` }
          : { dedupeKey }),
      });
    },
  );
  ipcMain.handle(
    IPC.analyticsGetStatus,
    async (): Promise<ProductAnalyticsStatus> => productAnalyticsService?.getStatus() ?? fallbackAnalyticsStatus(),
  );
  ipcMain.handle(
    IPC.analyticsSetEnabled,
    async (_event, enabled: boolean): Promise<ProductAnalyticsStatus> => {
      fallbackAnalyticsEnabled = enabled === true;
      return productAnalyticsService?.setEnabled(fallbackAnalyticsEnabled) ?? fallbackAnalyticsStatus();
    },
  );

  ipcMain.handle(
    IPC.localhostProbePort,
    async (_event, args: { port: number }): Promise<boolean> => {
      return probeLocalhostPort(args?.port);
    },
  );

  ipcMain.on(
    IPC.appLogDebugEvent,
    (event, arg: { event?: string; payload?: Record<string, unknown> | null }) => {
      const ctx = getCtx();
      const rawEvent = typeof arg?.event === "string" ? arg.event.trim() : "";
      if (!rawEvent) return;
      const eventName = rawEvent.startsWith("renderer.")
        ? rawEvent
        : `renderer.${rawEvent}`;
      const payload =
        arg?.payload && typeof arg.payload === "object" ? arg.payload : {};
      ctx.logger.info(eventName, {
        windowId: BrowserWindow.fromWebContents(event.sender)?.id ?? null,
        projectRoot: ctx.project.rootPath,
        ...payload,
      });
    },
  );

  ipcMain.handle(IPC.appGetProject, async () => {
    const ctx = getCtx();
    return ctx.hasUserSelectedProject ? ctx.project : null;
  });

  ipcMain.handle(IPC.appGetWindowSession, async (event) => {
    const windowId = BrowserWindow.fromWebContents(event.sender)?.id ?? null;
    if (getWindowSession) return getWindowSession(windowId);
    const ctx = getCtx();
    return {
      windowId,
      project: ctx.hasUserSelectedProject ? ctx.project : null,
      binding: ctx.hasUserSelectedProject
        ? {
          kind: "local",
          key: `local:${ctx.project.rootPath}`,
          rootPath: ctx.project.rootPath,
          displayName: ctx.project.displayName,
        }
        : null,
      openProjectTabs: ctx.hasUserSelectedProject ? [ctx.project] : [],
    };
  });

  ipcMain.handle(IPC.appGetWelcomeVideoState, async (): Promise<AppWelcomeVideoState> => {
    const state = readGlobalState(globalStatePath);
    return normalizeWelcomeVideoState(state.welcomeVideo);
  });

  ipcMain.handle(
    IPC.appMarkWelcomeVideoSeen,
    async (_event, arg: { reason?: "completed" | "dismissed" } = {}): Promise<AppWelcomeVideoState> => {
      const state = readGlobalState(globalStatePath);
      const current = normalizeWelcomeVideoState(state.welcomeVideo);
      const timestamp = new Date().toISOString();
      const next: AppWelcomeVideoState = {
        ...current,
        completedAt: arg.reason === "completed" ? timestamp : current.completedAt,
        dismissedAt: arg.reason === "completed" ? current.dismissedAt : timestamp,
      };
      writeGlobalState(globalStatePath, {
        ...state,
        welcomeVideo: next,
      });
      return next;
    },
  );

  ipcMain.handle(IPC.appGetLaunchGateState, async () => ({
    resolved: launchGateResolved,
  }));

  ipcMain.handle(IPC.appResolveLaunchGate, async () => {
    launchGateResolved = true;
    return { resolved: true as const };
  });

  ipcMain.handle(IPC.appSetWindowProjectTabs, async (event, arg: { rootPaths?: string[] } = {}) => {
    const windowId = BrowserWindow.fromWebContents(event.sender)?.id ?? null;
    const rootPaths = Array.isArray(arg?.rootPaths)
      ? arg.rootPaths.filter((rootPath): rootPath is string => typeof rootPath === "string")
      : [];
    const openProjectTabs = setWindowProjectTabs
      ? setWindowProjectTabs(windowId, rootPaths)
      : [];
    return { openProjectTabs };
  });

  ipcMain.handle(IPC.appNewWindow, async () => {
    if (!createWindow) return { windowId: null };
    const result = await createWindow({ projectRoot: null });
    return { windowId: result.windowId };
  });

  ipcMain.handle(IPC.appOpenProjectInNewWindow, async (_event, arg: { rootPath?: string }) => {
    const rootPath = typeof arg?.rootPath === "string" ? arg.rootPath.trim() : "";
    if (!rootPath) throw new Error("rootPath is required");
    if (!createWindow) return { windowId: null, project: null };
    return createWindow({ projectRoot: rootPath });
  });

  ipcMain.handle(IPC.appCloseWindow, async (event, arg: { windowId?: number | null } = {}) => {
    const requestedWindowId = Number.isFinite(arg?.windowId)
      ? Number(arg.windowId)
      : BrowserWindow.fromWebContents(event.sender)?.id ?? null;
    if (!closeWindow) return { closed: false };
    return closeWindow(requestedWindowId);
  });

  ipcMain.handle(IPC.appOpenExternal, async (_event, arg: { url: string }): Promise<void> => {
    await openExternalUrl(arg?.url);
  });

  const resolveRendererSuppliedPath = (rawPath: string, projectRoot: string): string => {
    let inputPath = rawPath;
    if (/^ade-artifact:\/\/project(?:\/|$)/i.test(inputPath)) {
      const parsed = new URL(inputPath);
      inputPath = decodeURIComponent(parsed.pathname.replace(/^\/+/, ""));
    }
    if (/^file:\/\//i.test(inputPath)) {
      try {
        inputPath = fileURLToPath(inputPath);
      } catch {
        inputPath = decodeURIComponent(inputPath.replace(/^file:\/\//i, ""));
      }
    }
    return path.resolve(path.isAbsolute(inputPath) ? inputPath : path.join(projectRoot, inputPath));
  };

  const resolveAllowedRendererPath = (rawPath: string): string => {
    const raw = typeof rawPath === "string" ? rawPath.trim() : "";
    if (!raw) throw new Error("Missing path.");
    const ctx = getCtx();
    const normalized = resolveRendererSuppliedPath(raw, ctx.project.rootPath);
    const allowedDirs = getAllowedDirs(getCtx);
    // resolvePathWithinRoot follows symlinks via fs.realpath while validating
    // containment, so we both reject symlinks pointing outside the allowlist
    // *and* return the canonical real path for callers to read from. Returning
    // the lexical path would still be safe because the check resolved real
    // paths, but handing back the realpath avoids any TOCTOU-adjacent surprises
    // and keeps file I/O pinned to the validated target.
    let resolved: string | null = null;
    for (const dir of allowedDirs) {
      try {
        resolved = resolvePathWithinRoot(dir, normalized);
        break;
      } catch {
        // try next allowed dir
      }
    }
    if (!resolved) {
      throw new Error("Path is outside allowed directories.");
    }
    return resolved;
  };

  /**
   * Sniff the first bytes of a buffer for known image magic numbers and
   * return the corresponding MIME type. Returns null if the buffer doesn't
   * match any supported image format.
   *
   * We deliberately do NOT trust the file extension here — extension-only
   * inference would let a renderer hand us any allow-listed file (text,
   * binary, etc.) and get it back as a base64 `image/png` data URL.
   */
  const sniffImageMimeType = (buffer: Buffer): string | null => {
    if (buffer.length >= 8
      && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47
      && buffer[4] === 0x0D && buffer[5] === 0x0A && buffer[6] === 0x1A && buffer[7] === 0x0A) {
      return "image/png";
    }
    if (buffer.length >= 3
      && buffer[0] === 0xFF && buffer[1] === 0xD8 && buffer[2] === 0xFF) {
      return "image/jpeg";
    }
    if (buffer.length >= 6
      && buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x38
      && (buffer[4] === 0x37 || buffer[4] === 0x39) && buffer[5] === 0x61) {
      return "image/gif";
    }
    if (buffer.length >= 12
      && buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46
      && buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50) {
      return "image/webp";
    }
    if (buffer.length >= 2 && buffer[0] === 0x42 && buffer[1] === 0x4D) {
      return "image/bmp";
    }
    if (buffer.length >= 4
      && buffer[0] === 0x00 && buffer[1] === 0x00
      && buffer[2] === 0x01 && buffer[3] === 0x00) {
      return "image/x-icon";
    }
    // SVG/XML: scan a small prefix as text so leading whitespace, BOM, or an
    // <?xml ... ?> declaration before <svg ...> are tolerated.
    const head = buffer.slice(0, Math.min(buffer.length, 1024)).toString("utf8");
    const stripped = head.replace(/^﻿/, "").trimStart();
    if (/^<\?xml\b/i.test(stripped) && /<svg\b/i.test(head)) {
      return "image/svg+xml";
    }
    if (/^<svg\b/i.test(stripped)) {
      return "image/svg+xml";
    }
    return null;
  };

  const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
  const MAX_TEMP_ATTACHMENT_BYTES = 10 * 1024 * 1024;

  /**
   * Read an allow-listed image file from disk after a stat-based size check,
   * sniff its bytes for a known image magic, and return both the bytes and
   * the sniffed MIME type. Throws if the file is too large, isn't a regular
   * file, or doesn't look like a supported image.
   */
  const readImageFileAndSniffMime = async (filePath: string): Promise<{ data: Buffer; mimeType: string }> => {
    const stat = await fs.promises.stat(filePath);
    if (!stat.isFile()) {
      throw new Error("Path is not a file.");
    }
    if (stat.size > MAX_IMAGE_BYTES) {
      throw new Error("Image must be 10 MB or smaller.");
    }
    const data = await fs.promises.readFile(filePath);
    const mimeType = sniffImageMimeType(data);
    if (!mimeType) {
      throw new Error("Path is not an image.");
    }
    return { data, mimeType };
  };

  const saveAgentChatTempAttachmentBuffer = async (
    content: Buffer,
    filename: string,
  ): Promise<{ path: string }> => {
    if (content.byteLength > MAX_TEMP_ATTACHMENT_BYTES) {
      throw new Error("Temporary attachments must be 10 MB or smaller.");
    }
    const ctx = getCtx();
    // Save within the project's .ade directory so CLI subprocesses have
    // filesystem access. Fall back to system temp if no project is open.
    const baseDir = ctx.project?.rootPath
      ? path.join(ctx.project.rootPath, ".ade", "attachments")
      : path.join(app.getPath("temp"), "ade-attachments");
    await fs.promises.mkdir(baseDir, { recursive: true });
    const ext = path.extname(filename) || ".png";
    const destPath = path.join(baseDir, `${randomUUID()}${ext}`);
    await fs.promises.writeFile(destPath, content);
    return { path: destPath };
  };

  ipcMain.handle(IPC.appRevealPath, async (_event, arg: { path: string }): Promise<void> => {
    const raw = typeof arg?.path === "string" ? arg.path.trim() : "";
    if (!raw) return;
    const ctx = getCtx();
    const normalized = resolveRendererSuppliedPath(raw, ctx.project.rootPath);
    // Validate the path is within known safe directories only.
    // Reject requests to reveal arbitrary paths (e.g. ~/.ssh, /etc, /System).
    const allowedDirs = getAllowedDirs(getCtx);
    const allowed = allowedDirs.some((dir) => {
      try {
        resolvePathWithinRoot(dir, normalized);
        return true;
      } catch {
        return false;
      }
    });
    if (!allowed) {
      throw new Error("Path is outside allowed directories.");
    }
    shell.showItemInFolder(normalized);
  });

  ipcMain.handle(IPC.appOpenPath, async (_event, arg: { path: string }): Promise<void> => {
    const raw = typeof arg?.path === "string" ? arg.path.trim() : "";
    if (!raw) return;
    const ctx = getCtx();
    const normalized = resolveRendererSuppliedPath(raw, ctx.project.rootPath);
    const allowedDirs = getAllowedDirs(getCtx);
    const allowed = allowedDirs.some((dir) => {
      try {
        resolvePathWithinRoot(dir, normalized);
        return true;
      } catch {
        return false;
      }
    });
    if (!allowed) {
      throw new Error("Path is outside allowed directories.");
    }
    const errorMessage = await shell.openPath(normalized);
    if (errorMessage) {
      throw new Error(`Failed to open path: ${errorMessage}`);
    }
  });

  ipcMain.handle(IPC.appWriteClipboardText, async (_event, arg: { text: string }): Promise<void> => {
    const text = typeof arg?.text === "string" ? arg.text : "";
    clipboard.writeText(text);
  });

  ipcMain.handle(IPC.appReadClipboardText, async (event): Promise<string> => {
    assertTrustedAppControlSender(event, IPC.appReadClipboardText);
    return clipboard.readText() ?? "";
  });

  ipcMain.handle(IPC.appHasClipboardImage, async (): Promise<boolean> => {
    return !clipboard.readImage().isEmpty();
  });

  ipcMain.handle(IPC.appReadClipboardImage, async (): Promise<{ data: string; filename: string; mimeType: string } | null> => {
    const image = clipboard.readImage();
    if (image.isEmpty()) return null;
    const png = image.toPNG();
    if (!png.byteLength) return null;
    if (png.byteLength > MAX_TEMP_ATTACHMENT_BYTES) {
      throw new Error("Clipboard image must be 10 MB or smaller.");
    }
    return {
      data: png.toString("base64"),
      filename: "clipboard.png",
      mimeType: "image/png",
    };
  });

  ipcMain.handle(IPC.appSaveClipboardImageAttachment, async (): Promise<{ path: string; mimeType: string; previewDataUrl: string | null } | null> => {
    const image = clipboard.readImage();
    if (image.isEmpty()) return null;
    const png = image.toPNG();
    if (!png.byteLength) return null;
    if (png.byteLength > MAX_TEMP_ATTACHMENT_BYTES) {
      throw new Error("Clipboard image must be 10 MB or smaller.");
    }
    const saved = await saveAgentChatTempAttachmentBuffer(png, "clipboard.png");
    const previewImage = image.resize({ width: 96, height: 96, quality: "best" });
    return {
      path: saved.path,
      mimeType: "image/png",
      previewDataUrl: previewImage.isEmpty() ? null : previewImage.toDataURL(),
    };
  });

  ipcMain.handle(IPC.appGetImageDataUrl, async (_event, arg: { path: string }): Promise<{ dataUrl: string }> => {
    const filePath = resolveAllowedRendererPath(arg?.path);
    // Use async fs APIs and a size pre-check so a 10 MB image read never
    // blocks the main process event loop (input dispatch, IPC, window
    // animations all share that loop). The MIME type is derived from the
    // file's *bytes*, not its extension, so a renderer can't smuggle
    // arbitrary text/binary back as a base64 `image/png` data URL.
    const { data, mimeType } = await readImageFileAndSniffMime(filePath);
    return {
      dataUrl: `data:${mimeType};base64,${data.toString("base64")}`,
    };
  });

  ipcMain.handle(IPC.appWriteClipboardImage, async (_event, arg: { path: string }): Promise<void> => {
    const filePath = resolveAllowedRendererPath(arg?.path);
    // Apply the same size + magic-byte preflight as `appGetImageDataUrl` so
    // we can't hand `nativeImage.createFromPath` a giant or non-image file
    // (which would otherwise silently produce an empty image, or worse,
    // attempt a sync read of a 100 MB binary on the main process). We then
    // hand the already-read buffer to `nativeImage.createFromBuffer` so the
    // file isn't read a second time off the main thread.
    const { data } = await readImageFileAndSniffMime(filePath);
    const image = nativeImage.createFromBuffer(data);
    if (image.isEmpty()) {
      throw new Error("Unable to read image.");
    }
    clipboard.writeImage(image);
  });

  ipcMain.handle(
    IPC.appOpenPathInEditor,
    async (
      _event,
      arg: { rootPath: string; relativePath?: string; target: "default" | "finder" | "vscode" | "cursor" | "zed" }
    ): Promise<void> => {
      const rootRaw = typeof arg?.rootPath === "string" ? arg.rootPath.trim() : "";
      const relRaw = typeof arg?.relativePath === "string" ? arg.relativePath.trim() : "";
      const target = arg?.target;
      if (!rootRaw) throw new Error("Missing root path.");
      if (target !== "default" && target !== "finder" && target !== "vscode" && target !== "cursor" && target !== "zed") {
        throw new Error("Unsupported editor target.");
      }
      const rootPath = path.resolve(rootRaw);

      // Validate the renderer-supplied root is a known workspace root
      // (same pattern as appRevealPath).
      const allowedRoots = getAllowedDirs(getCtx);
      const rootAllowed = allowedRoots.some((dir) => {
        try {
          resolvePathWithinRoot(dir, rootPath);
          return true;
        } catch {
          return false;
        }
      }) || getCtx().fileService?.isExternalWorkspaceRoot(rootPath) === true;
      if (!rootAllowed) {
        throw new Error("rootPath is outside allowed directories.");
      }

      let targetPath: string;
      try {
        const candidatePath = relRaw ? path.resolve(rootPath, relRaw) : rootPath;
        targetPath = resolvePathWithinRoot(rootPath, candidatePath, { allowMissing: true });
      } catch (resolveError: unknown) {
        // Only translate containment errors; rethrow unexpected failures.
        if (resolveError instanceof Error && resolveError.message === "Path escapes root") {
          throw new Error("relativePath escapes rootPath.");
        }
        throw resolveError;
      }

      if (target === "default") {
        const errorMessage = await shell.openPath(targetPath);
        if (errorMessage) {
          throw new Error(`Failed to open path: ${errorMessage}`);
        }
        return;
      }

      if (target === "finder") {
        shell.showItemInFolder(targetPath);
        return;
      }

      const launchDetached = async (
        command: string,
        args: string[],
        options?: { windowsVerbatimArguments?: boolean; resolveOn?: "spawn" | "exit" },
      ): Promise<void> => {
        await new Promise<void>((resolve, reject) => {
          let settled = false;
          const resolveOn = options?.resolveOn ?? "spawn";
          try {
            const child = spawn(command, args, {
              detached: true,
              stdio: "ignore",
              windowsVerbatimArguments: options?.windowsVerbatimArguments,
            });
            child.once("error", (error) => {
              if (settled) return;
              settled = true;
              reject(error);
            });
            child.once("spawn", () => {
              if (resolveOn !== "spawn") return;
              if (settled) return;
              settled = true;
              child.unref();
              resolve();
            });
            child.once("exit", (code) => {
              if (resolveOn !== "exit") return;
              if (settled) return;
              settled = true;
              child.unref();
              if (code === 0) {
                resolve();
              } else {
                reject(new Error(`exit code ${code}`));
              }
            });
          } catch (error) {
            reject(error);
          }
        });
      };

      const launchAttempts = async (
        attempts: Array<{ command: string; args: string[]; windowsVerbatimArguments?: boolean; resolveOn?: "spawn" | "exit" }>,
      ): Promise<void> => {
        let lastError: unknown = null;
        for (const attempt of attempts) {
          try {
            await launchDetached(attempt.command, attempt.args, {
              windowsVerbatimArguments: attempt.windowsVerbatimArguments,
              resolveOn: attempt.resolveOn,
            });
            return;
          } catch (error) {
            lastError = error;
          }
        }
        throw lastError instanceof Error ? lastError : new Error("Failed to launch external editor.");
      };

      const attempts: Array<{ command: string; args: string[]; windowsVerbatimArguments?: boolean; resolveOn?: "spawn" | "exit" }> = [];
      const cliCommand = target === "vscode" ? "code" : target === "cursor" ? "cursor" : "zed";

      if (process.platform === "darwin") {
        const appName = target === "vscode" ? "Visual Studio Code" : target === "cursor" ? "Cursor" : "Zed";
        attempts.push({ command: "open", args: ["-a", appName, targetPath] });
      }
      if (process.platform === "win32") {
        // `start "" <command> <args>` — empty title is required when the next token is quoted.
        const windowsShell = process.env.ComSpec?.trim() || "cmd.exe";
        attempts.push({
          command: windowsShell,
          args: ["/d", "/s", "/c", `start "" ${quoteWindowsCmdArg(cliCommand)} ${quoteWindowsCmdArg(targetPath)}`],
          windowsVerbatimArguments: true,
          resolveOn: "exit",
        });
      }
      attempts.push({ command: cliCommand, args: [targetPath] });

      try {
        await launchAttempts(attempts);
      } catch {
        throw new Error(`Unable to open file in ${target}. Ensure it is installed and available.`);
      }
    }
  );

  ipcMain.handle(IPC.appGetInfo, async (): Promise<AppInfo> => {
    return {
      appVersion: app.getVersion(),
      isPackaged: app.isPackaged,
      automationsEnabled: areAutomationsEnabledForPackagedState(app.isPackaged),
      platform: process.platform,
      arch: process.arch,
      versions: {
        electron: process.versions.electron ?? "unknown",
        chrome: process.versions.chrome ?? "unknown",
        node: process.versions.node ?? "unknown",
        v8: process.versions.v8 ?? "unknown"
      },
      env: {
        nodeEnv: process.env.NODE_ENV,
        viteDevServerUrl: process.env.VITE_DEV_SERVER_URL
      },
      localRuntime: localRuntimeConnectionPool?.getStatus() ?? null
    };
  });

  ipcMain.handle(IPC.appGetResourceUsage, async (): Promise<AppResourceUsageSnapshot> => {
    const ctx = getCtx();
    const contexts = getResourceUsageContexts?.() ?? [ctx];
    return getCachedAppResourceUsageSnapshot(
      contexts.length > 0 ? contexts : [ctx],
      localRuntimeConnectionPool,
    );
  });

  ipcMain.handle(IPC.storageGetPressure, async (): Promise<DiskPressureSnapshot> => {
    const monitor = requireAppContextValue(getCtx(), "diskPressureMonitor");
    return monitor.getSnapshot({ maxAgeMs: 1_000 });
  });

  ipcMain.handle(IPC.storageGetSnapshot, async (
    _event,
    args: { forceRefresh?: boolean } | undefined,
  ): Promise<StorageSnapshot> => {
    const service = requireAppContextValue(getCtx(), "storageInsightsService");
    return service.getSnapshot(args ?? {});
  });

  ipcMain.handle(IPC.storageCompressNow, async (): Promise<StorageCompressionResult> => {
    const service = requireAppContextValue(getCtx(), "storageInsightsService");
    return service.compressNow();
  });

  ipcMain.handle(IPC.storageCleanupPreview, async (
    _event,
    targets: StorageCleanupTarget[],
  ): Promise<StorageCleanupPreview> => {
    const service = requireAppContextValue(getCtx(), "storageInsightsService");
    return service.cleanupPreview(targets);
  });

  ipcMain.handle(IPC.storageCleanup, async (
    _event,
    args: { targets: StorageCleanupTarget[]; preview: StorageCleanupPreview },
  ): Promise<StorageCleanupResult> => {
    const service = requireAppContextValue(getCtx(), "storageInsightsService");
    return service.cleanup(args.targets, { preview: args.preview });
  });

  ipcMain.handle(IPC.appGetLatestRelease, async (): Promise<LatestReleaseInfo | null> => {
    let token: string | null = null;
    try {
      token = getCtx().githubService.getTokenOrThrow();
    } catch {
      token = null;
    }
    const release = await fetchAdeLatestRelease({ token });
    if (!release) return null;
    const updateAvailable =
      app.isPackaged && compareUpdateVersions(release.version, app.getVersion()) > 0;
    return {
      version: release.version,
      htmlUrl: release.htmlUrl,
      publishedAt: release.publishedAt,
      updateAvailable,
    };
  });

  ipcMain.handle(IPC.projectOpenRepo, async (event, args: { rootPath?: string } = {}): Promise<ProjectInfo | null> => {
    // The chosen root is only known in the main process (the OS dialog picks
    // it), so a coded open failure must carry it back to the renderer for the
    // recovery screen — otherwise a disk-full/db-repair failure from the Open
    // Repository flow falls back to the generic banner with no Repair action.
    let chosenRoot: string | undefined;
    try {
      const requestedRoot = args.rootPath?.trim();
      if (requestedRoot) {
        chosenRoot = requestedRoot;
        return await switchProjectFromDialog(requestedRoot);
      }
      const win = BrowserWindow.fromWebContents(event.sender) ?? undefined;
      const options: Electron.OpenDialogOptions = {
        title: "Open repository",
        properties: ["openDirectory"]
      };
      const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
      if (result.canceled || result.filePaths.length === 0) {
        return null;
      }
      const selected = result.filePaths[0]!;
      chosenRoot = selected;
      return await switchProjectFromDialog(selected);
    } catch (error) {
      return surfaceCodedError(error, chosenRoot ? { rootPath: chosenRoot } : undefined);
    }
  });

  ipcMain.handle(
    IPC.projectChooseDirectory,
    async (event, args: { title?: string; defaultPath?: string } = {}): Promise<string | null> => {
      const win = BrowserWindow.fromWebContents(event.sender) ?? undefined;
      const options: Electron.OpenDialogOptions = {
        title: args.title?.trim() || "Choose directory",
        defaultPath: args.defaultPath?.trim() || undefined,
        properties: ["openDirectory"]
      };
      const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
      if (result.canceled || result.filePaths.length === 0) return null;
      return result.filePaths[0] ?? null;
    }
  );

  ipcMain.handle(
    IPC.projectBrowseDirectories,
    async (_event, args: ProjectBrowseInput = {}): Promise<ProjectBrowseResult> =>
      browseProjectDirectories(args)
  );

  const PROJECT_DETAIL_CACHE_TTL_MS = 10_000;
  const projectDetailCache = new Map<string, {
    expiresAtMs: number;
    promise: Promise<ProjectDetail>;
  }>();
  const getCachedProjectDetail = (rootPath: string): Promise<ProjectDetail> => {
    const now = Date.now();
    const cached = projectDetailCache.get(rootPath);
    // Cache hit when either the TTL is still valid (resolved entry) or the
    // entry is still in flight (sentinel = Infinity). Without the in-flight
    // arm, a slow `getProjectDetail` call can blow the start-time TTL while
    // still pending, causing duplicate concurrent fetches for the same root.
    if (cached && (cached.expiresAtMs > now || cached.expiresAtMs === Number.POSITIVE_INFINITY)) {
      return cached.promise;
    }
    const promise = getProjectDetail(rootPath, { globalStatePath });
    projectDetailCache.set(rootPath, {
      // Keep pending requests deduped; the TTL only starts once the promise
      // settles successfully.
      expiresAtMs: Number.POSITIVE_INFINITY,
      promise,
    });
    if (projectDetailCache.size > 64) {
      const oldestKey = projectDetailCache.keys().next().value;
      if (typeof oldestKey === "string") projectDetailCache.delete(oldestKey);
    }
    promise.then(() => {
      const current = projectDetailCache.get(rootPath);
      if (current?.promise === promise) {
        current.expiresAtMs = Date.now() + PROJECT_DETAIL_CACHE_TTL_MS;
      }
    });
    promise.catch(() => {
      if (projectDetailCache.get(rootPath)?.promise === promise) {
        projectDetailCache.delete(rootPath);
      }
    });
    return promise;
  };

  ipcMain.handle(
    IPC.projectGetDetail,
    async (_event, args: { rootPath: string }): Promise<ProjectDetail> => {
      const rootPath = typeof args?.rootPath === "string" ? args.rootPath.trim() : "";
      if (!rootPath) throw new Error("rootPath is required");
      return getCachedProjectDetail(rootPath);
    }
  );

  ipcMain.handle(
    IPC.projectInspectPath,
    async (_event, arg: { path?: unknown; fresh?: unknown } = {}): Promise<ProjectPathInspection> =>
      inspectProjectPathCached(String(arg?.path ?? ""), { fresh: arg?.fresh === true }),
  );

  // Project-root allowlist for icon resolution. Tab/catalog icons are
  // resolved for the *current* project root and any *recently opened*
  // project root — including ones that live outside Downloads/Documents/Temp
  // (the generic `getAllowedDirs` set). Using `resolveAllowedRendererPath`
  // here would silently strip icons for any project in `~/code/*` etc.
  const getAllowedProjectRoots = (): string[] => {
    const state = readGlobalState(globalStatePath);
    return Array.from(new Set([
      getCtx().project.rootPath,
      ...(state.recentProjects ?? [])
        .filter((entry) => !entry.remote)
        .map((entry) => entry.rootPath)
        .filter((root): root is string => typeof root === "string" && root.trim().length > 0),
    ]));
  };

  const resolveAllowedProjectRoot = (rawPath: string): string => {
    const raw = typeof rawPath === "string" ? rawPath.trim() : "";
    if (!raw) throw new Error("Missing root path.");
    const normalized = resolveRendererSuppliedPath(raw, getCtx().project.rootPath);
    for (const dir of getAllowedProjectRoots()) {
      try {
        return resolvePathWithinRoot(dir, normalized);
      } catch {
        // try next known project root
      }
    }
    throw new Error("rootPath is outside known project roots.");
  };

  ipcMain.handle(
    IPC.projectResolveIcon,
    async (_event, args: { rootPath: string }): Promise<ProjectIcon> => {
      const rootPath = typeof args?.rootPath === "string" ? args.rootPath.trim() : "";
      if (!rootPath) return { dataUrl: null, sourcePath: null, mimeType: null };
      // Validate the renderer-supplied root against the project-root
      // allowlist (current + recent projects) so a compromised renderer
      // can't probe arbitrary directories for icons, while still serving
      // icons for projects that live outside the generic file allowlist.
      let validatedRoot: string;
      try {
        validatedRoot = resolveAllowedProjectRoot(rootPath);
      } catch {
        return { dataUrl: null, sourcePath: null, mimeType: null };
      }
      const sourcePath = resolveProjectIconPath(validatedRoot);
      if (!sourcePath) return { dataUrl: null, sourcePath: null, mimeType: null };
      const image = nativeImage.createFromPath(sourcePath);
      if (!image.isEmpty()) {
        return {
          dataUrl: image.resize({ width: 64, height: 64, quality: "best" }).toDataURL(),
          sourcePath,
          mimeType: "image/png",
        };
      }
      return resolveProjectIcon(validatedRoot);
    },
  );

  ipcMain.handle(
    IPC.projectChooseIcon,
    async (event, args: { rootPath: string }): Promise<ProjectIcon | null> => {
      const rootPath = typeof args?.rootPath === "string" ? args.rootPath.trim() : "";
      if (!rootPath) return null;
      let validatedRoot: string;
      try {
        validatedRoot = resolveAllowedProjectRoot(rootPath);
      } catch {
        return null;
      }

      const win = BrowserWindow.fromWebContents(event.sender) ?? undefined;
      const options: Electron.OpenDialogOptions = {
        title: "Choose project icon",
        defaultPath: validatedRoot,
        properties: ["openFile"],
        filters: [
          { name: "Images", extensions: ["ico", "jpeg", "jpg", "png", "svg", "webp"] },
        ],
      };
      const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
      if (result.canceled || result.filePaths.length === 0) return null;

      const selectedPath = result.filePaths[0];
      if (!selectedPath) return null;
      try {
        return setProjectIconOverrideFromSelection(validatedRoot, selectedPath);
      } catch (error) {
        // Surface validation/import failures so the renderer can display a
        // meaningful error instead of a silently rejected promise.
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Failed to set project icon: ${message}`);
      }
    },
  );

  ipcMain.handle(
    IPC.projectRemoveIcon,
    async (_event, args: { rootPath: string }): Promise<ProjectIcon> => {
      const rootPath = typeof args?.rootPath === "string" ? args.rootPath.trim() : "";
      if (!rootPath) return { dataUrl: null, sourcePath: null, mimeType: null };
      let validatedRoot: string;
      try {
        validatedRoot = resolveAllowedProjectRoot(rootPath);
      } catch {
        return { dataUrl: null, sourcePath: null, mimeType: null };
      }
      return removeProjectIconOverride(validatedRoot);
    },
  );

  ipcMain.handle(IPC.projectOpenAdeFolder, async (): Promise<void> => {
    const ctx = getCtx();
    await shell.openPath(ctx.adeDir);
  });

  ipcMain.handle(IPC.projectClearLocalData, async (_event, arg: ClearLocalAdeDataArgs = {}): Promise<ClearLocalAdeDataResult> => {
    const ctx = getCtx();
    if (ctx.adeProjectService) {
      return ctx.adeProjectService.clearLocalData(arg);
    }

    const clearedAt = nowIso();
    const deletedPaths: string[] = [];

    const rmrf = (absPath: string) => {
      const resolved = path.resolve(absPath);
      const allowedRoot = path.resolve(ctx.adeDir) + path.sep;
      if (!resolved.startsWith(allowedRoot)) {
        throw new Error("Refusing to delete outside .ade directory");
      }
      if (!fs.existsSync(resolved)) return;
      fs.rmSync(resolved, { recursive: true, force: true });
      deletedPaths.push(resolved);
    };

    if (arg.packs) rmrf(path.join(ctx.adeDir, "artifacts"));
    if (arg.logs) rmrf(path.join(ctx.adeDir, "transcripts", "logs"));
    if (arg.transcripts) rmrf(path.join(ctx.adeDir, "transcripts"));

    return { deletedPaths, clearedAt };
  });

  const RECENT_PROJECT_SUMMARY_CACHE_TTL_MS = 5_000;
  let recentProjectSummaryCache: {
    signature: string;
    rows: RecentProjectSummary[];
    expiresAtMs: number;
  } | null = null;
  const recentProjectSignature = (
    entries: RecentProject[],
  ): string => JSON.stringify(entries.map((entry) => [
    entry.rootPath,
    entry.displayName,
    entry.lastOpenedAt,
    entry.remote ? recentProjectKey(entry) : null,
    entry.pinned ? 1 : 0,
  ]));
  const listRecentProjectSummaries = (options?: { force?: boolean }): RecentProjectSummary[] => {
    const state = readGlobalState(globalStatePath);
    const entries = state.recentProjects ?? [];
    const signature = recentProjectSignature(entries);
    const now = Date.now();
    if (
      !options?.force
      && recentProjectSummaryCache
      && recentProjectSummaryCache.signature === signature
      && recentProjectSummaryCache.expiresAtMs > now
    ) {
      return recentProjectSummaryCache.rows;
    }
    const rows = entries.map(toShallowRecentProjectSummary);
    recentProjectSummaryCache = {
      signature,
      rows,
      expiresAtMs: now + RECENT_PROJECT_SUMMARY_CACHE_TTL_MS,
    };
    return rows;
  };
  const listLocalRecentProjectSummaries = (): RecentProjectSummary[] =>
    listRecentProjectSummaries().filter((entry) => entry.kind !== "remote");
  const clearRecentProjectSummaryCache = (): void => {
    recentProjectSummaryCache = null;
  };

  ipcMain.handle(IPC.projectListRecent, async (): Promise<RecentProjectSummary[]> =>
    listRecentProjectSummaries()
  );

  ipcMain.handle(
    IPC.projectFindForRepo,
    async (_event, arg: { repoOwner?: string; repoName?: string } = {}): Promise<{ rootPath: string; displayName: string } | null> => {
      const repoOwner = typeof arg?.repoOwner === "string" ? arg.repoOwner.trim() : "";
      const repoName = typeof arg?.repoName === "string" ? arg.repoName.trim() : "";
      if (!repoOwner || !repoName) return null;
      // One tested implementation: parses each recent project's git origin
      // from .git/config (no git subprocess), cached by config mtime.
      return findRecentProjectForRepo(listLocalRecentProjectSummaries(), { repoOwner, repoName });
    },
  );

  const runtimeBridge = registerRuntimeBridge({
    appVersion: app.getVersion(),
    bindRemoteProject,
    getGitHubTokenForRemoteClone: () => {
      try {
        return getCtx().githubService.getTokenOrThrow();
      } catch {
        return null;
      }
    },
    getWindowSession,
    globalStatePath,
    localRuntimeConnectionPool,
  });

  ipcMain.handle(
    IPC.projectCreateLocal,
    async (_event, arg: CreateProjectInput): Promise<CreateProjectResult> => {
      const name = typeof arg?.name === "string" ? arg.name.trim() : "";
      const parentDir = typeof arg?.parentDir === "string" ? arg.parentDir.trim() : "";
      if (!name) throw new Error("Project name is required.");
      if (!parentDir) throw new Error("Parent directory is required.");
      const ctx = getCtx();
      try {
        return await ctx.projectScaffoldService.createLocalProject({ name, parentDir });
      } catch (error) {
        return surfaceCodedError(error);
      }
    },
  );

  ipcMain.handle(
    IPC.projectClone,
    async (_event, arg: CloneProjectInput): Promise<CloneProjectResult> => {
      const url = typeof arg?.url === "string" ? arg.url.trim() : "";
      const parentDir = typeof arg?.parentDir === "string" ? arg.parentDir.trim() : "";
      const name = typeof arg?.name === "string" ? arg.name.trim() : undefined;
      if (!url) throw new Error("Repository URL is required.");
      if (!parentDir) throw new Error("Parent directory is required.");
      const ctx = getCtx();
      try {
        return await ctx.projectScaffoldService.cloneRepository({
          url,
          parentDir,
          ...(name ? { name } : {}),
        });
      } catch (error) {
        return surfaceCodedError(error);
      }
    },
  );

  ipcMain.handle(IPC.projectGetDefaultParentDir, async (): Promise<string> => {
    const ctx = getCtx();
    return ctx.projectScaffoldService.getDefaultParentDir(listLocalRecentProjectSummaries());
  });

  ipcMain.handle(IPC.projectCloseCurrent, async (): Promise<void> => {
    await closeCurrentProject();
  });

  ipcMain.handle(IPC.projectForgetRecent, async (_event, arg: { rootPath?: string; key?: string }): Promise<RecentProjectSummary[]> => {
    // `key` is the stable recent identity (rootPath for local, remote:… for
    // remote). Older callers pass only `rootPath`; for local entries the key
    // and the rootPath are identical, so this stays backward compatible.
    const targetKey = (typeof arg?.key === "string" && arg.key.trim())
      || (typeof arg?.rootPath === "string" && arg.rootPath.trim())
      || "";
    const state = readGlobalState(globalStatePath);
    if (!targetKey) {
      return listRecentProjectSummaries();
    }
    const entries = state.recentProjects ?? [];
    const removed = entries.find((entry) => recentProjectKey(entry) === targetKey);
    const filtered = entries.filter((entry) => recentProjectKey(entry) !== targetKey);
    const next = { ...state, recentProjects: filtered };
    if (removed && !removed.remote && next.lastProjectRoot === removed.rootPath) {
      delete next.lastProjectRoot;
    }
    writeGlobalState(globalStatePath, next);
    clearRecentProjectSummaryCache();
    if (removed && !removed.remote) {
      const catalogPool = localRuntimeConnectionPool ?? projectRecoveryConnectionPool;
      if (catalogPool) {
        try {
          await catalogPool.setProjectCatalogVisibility(
            removed.rootPath,
            "system",
            "desktop",
          );
        } catch {
          // Best effort; the desktop recent remains forgotten even if the
          // background service is temporarily unavailable.
        }
      }
    }
    // Only local projects have foreground services / open windows to tear down.
    if (removed && !removed.remote) {
      try {
        await closeProjectByPath(removed.rootPath);
      } catch {
        // Best effort; forgetting a project should still update recents even if teardown fails.
      }
    }
    return listRecentProjectSummaries({ force: true });
  });

  ipcMain.handle(IPC.projectSetRecentPinned, async (_event, arg: { key?: string; pinned?: boolean }): Promise<RecentProjectSummary[]> => {
    const key = typeof arg?.key === "string" ? arg.key.trim() : "";
    if (!key) {
      return listRecentProjectSummaries();
    }
    const state = readGlobalState(globalStatePath);
    const next = setRecentProjectPinned(state, key, Boolean(arg?.pinned));
    writeGlobalState(globalStatePath, next);
    clearRecentProjectSummaryCache();
    return listRecentProjectSummaries({ force: true });
  });

  ipcMain.handle(IPC.projectReorderRecent, async (_event, arg: { orderedPaths: string[] }): Promise<RecentProjectSummary[]> => {
    const orderedPaths = Array.isArray(arg?.orderedPaths) ? arg.orderedPaths.filter((p): p is string => typeof p === "string" && p.length > 0) : [];
    if (orderedPaths.length === 0) {
      return listRecentProjectSummaries();
    }
    const state = readGlobalState(globalStatePath);
    const next = reorderRecentProjects(state, orderedPaths);
    writeGlobalState(globalStatePath, next);
    clearRecentProjectSummaryCache();
    return listRecentProjectSummaries({ force: true });
  });

  ipcMain.handle(IPC.projectSwitchToPath, async (_event, arg: { rootPath: string }): Promise<ProjectInfo> => {
    try {
      const rootPath = typeof arg?.rootPath === "string" ? arg.rootPath.trim() : "";
      if (!rootPath) return getCtx().project;
      const ctx = getCtx();
      if (ctx.hasUserSelectedProject && rootPath === ctx.project.rootPath) return ctx.project;
      return await switchProjectFromDialog(rootPath);
    } catch (error) {
      return surfaceCodedError(error);
    }
  });

  ipcMain.handle(IPC.recoveryDiagnose, async (_event, arg: { projectRoot: string }): Promise<ProjectRecoveryDiagnosis> => {
    const projectRoot = typeof arg?.projectRoot === "string" ? arg.projectRoot.trim() : "";
    if (!projectRoot) throw new Error("Project root path is required.");
    if (!projectRecoveryService) throw new Error("Project recovery is unavailable in this runtime mode.");
    return await projectRecoveryService.diagnose(projectRoot);
  });

  // Return the complete ordered step array with the final report. The current
  // alert only needs one result, so it does not need a separate event lifecycle.
  ipcMain.handle(IPC.recoveryRepair, async (_event, arg: { projectRoot: string }): Promise<ProjectRepairReport> => {
    const projectRoot = typeof arg?.projectRoot === "string" ? arg.projectRoot.trim() : "";
    if (!projectRoot) throw new Error("Project root path is required.");
    if (!projectRecoveryService) throw new Error("Project recovery is unavailable in this runtime mode.");
    return await projectRecoveryService.repair(projectRoot);
  });

  ipcMain.handle(IPC.projectStateGetSnapshot, async (): Promise<AdeProjectSnapshot> => {
    const ctx = getCtx();
    if (!ctx.adeProjectService) throw new Error("Project state service unavailable.");
    return ctx.adeProjectService.getSnapshot();
  });

  ipcMain.handle(IPC.projectStateInitializeOrRepair, async (): Promise<AdeCleanupResult> => {
    const ctx = getCtx();
    if (!ctx.adeProjectService) throw new Error("Project state service unavailable.");
    return ctx.adeProjectService.initializeOrRepair();
  });

  ipcMain.handle(IPC.projectStateRunIntegrityCheck, async (): Promise<AdeCleanupResult> => {
    const ctx = getCtx();
    if (!ctx.adeProjectService) throw new Error("Project state service unavailable.");
    return ctx.adeProjectService.runIntegrityCheck();
  });

  ipcMain.handle(IPC.keybindingsGet, async (): Promise<KeybindingsSnapshot> => {
    const ctx = getCtx();
    requireAppContextServices(ctx, ["keybindingsService"] as const);
    return ctx.keybindingsService.get();
  });

  ipcMain.handle(IPC.keybindingsSet, async (_event, arg: { overrides: KeybindingOverride[] }): Promise<KeybindingsSnapshot> => {
    const ctx = getCtx();
    requireAppContextServices(ctx, ["keybindingsService"] as const);
    return ctx.keybindingsService.set({ overrides: arg?.overrides ?? [] });
  });

  ipcMain.handle(IPC.aiGetStatus, async (_event, arg?: { force?: boolean; refreshOpenCodeInventory?: boolean }): Promise<AiSettingsStatus> => {
    const ctx = getCtx();
    const aiIntegrationService = ctx.aiIntegrationService;
    if (!aiIntegrationService) {
      try {
        return await buildGlobalAiStatus({ force: arg?.force === true });
      } catch (error) {
        ctx.logger.warn("ai.get_status.global_fallback_failed", {
          error: getErrorMessage(error),
        });
        return getUnavailableAiStatus();
      }
    }
    try {
      const status = await aiIntegrationService.getStatus({
        force: arg?.force === true,
        refreshOpenCodeInventory: arg?.refreshOpenCodeInventory === true,
      });
      // Single query for all feature daily usage instead of N individual queries
      const usageBatch = aiIntegrationService.getDailyUsageBatch(AI_USAGE_FEATURE_KEYS);
      return {
        mode: status.mode,
        availableProviders: status.availableProviders,
        models: status.models,
        detectedAuth: status.detectedAuth,
        providerConnections: status.providerConnections,
        runtimeConnections: status.runtimeConnections,
        availableModelIds: status.availableModelIds,
        opencodeBinaryInstalled: status.opencodeBinaryInstalled,
        opencodeBinarySource: status.opencodeBinarySource,
        opencodeInventoryError: status.opencodeInventoryError,
        opencodeProviders: status.opencodeProviders,
        apiKeyStore: status.apiKeyStore,
        features: AI_USAGE_FEATURE_KEYS.map((feature) => ({
          feature,
          enabled: aiIntegrationService.getFeatureFlag(feature),
          dailyUsage: usageBatch.get(feature) ?? 0,
          dailyLimit: aiIntegrationService.getDailyBudgetLimit(feature)
        }))
      };
    } catch (error) {
      if (isDatabaseClosedError(error)) {
        ctx.logger.info("ai.get_status.unavailable_during_shutdown", {
          projectRoot: ctx.project?.rootPath ?? null,
        });
        return getUnavailableAiStatus();
      }
      throw error;
    }
  });

  ipcMain.handle(IPC.aiGetOpenCodeRuntimeDiagnostics, async (): Promise<OpenCodeRuntimeSnapshot> => {
    const { getOpenCodeRuntimeSnapshot } = await import("../opencode/openCodeRuntime");
    return getOpenCodeRuntimeSnapshot();
  });

  // Cheap binary-only check (no probe, no server boot). Used by the renderer
  // for instant first-paint of OpenCode-gated UI without waiting on the full
  // ~2s getStatus() roundtrip.
  ipcMain.handle(IPC.aiIsOpenCodeInstalled, async (): Promise<{ installed: boolean; source: "user-installed" | "bundled" | "missing" }> => {
    const { resolveOpenCodeBinary } = await import("../opencode/openCodeBinaryManager");
    const info = resolveOpenCodeBinary();
    return { installed: Boolean(info.path), source: info.source };
  });

  ipcMain.handle(IPC.aiStoreApiKey, async (_event, arg: { provider: string; key: string }): Promise<void> => {
    const ctx = getCtx();
    const { storeApiKey } = await import("../ai/apiKeyStore");
    storeApiKey(arg.provider, arg.key);
    try {
      // The key store mutation already succeeded; invalidation is a freshness
      // step so settings save/delete should not fail if a runtime cache is gone.
      ctx.aiIntegrationService?.invalidateProviderReadinessCaches();
    } catch (error) {
      ctx.logger.warn("ai.api_key_cache_invalidation_failed", {
        provider: arg.provider,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  ipcMain.handle(IPC.aiDeleteApiKey, async (_event, arg: { provider: string }): Promise<void> => {
    const ctx = getCtx();
    const { deleteApiKey } = await import("../ai/apiKeyStore");
    deleteApiKey(arg.provider);
    try {
      // The key store mutation already succeeded; invalidation is a freshness
      // step so settings save/delete should not fail if a runtime cache is gone.
      ctx.aiIntegrationService?.invalidateProviderReadinessCaches();
    } catch (error) {
      ctx.logger.warn("ai.api_key_cache_invalidation_failed", {
        provider: arg.provider,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  ipcMain.handle(IPC.aiListApiKeys, async (): Promise<string[]> => {
    const { listStoredProviders } = await import("../ai/apiKeyStore");
    return listStoredProviders();
  });

  ipcMain.handle(
    IPC.aiVerifyApiKey,
    async (_event, arg: { provider: string }): Promise<AiApiKeyVerificationResult> => {
      const ctx = getCtx();
      requireAppContextServices(ctx, ["aiIntegrationService"] as const);
      return await ctx.aiIntegrationService.verifyApiKeyConnection(arg.provider);
    },
  );

  ipcMain.handle(IPC.aiUpdateConfig, async (_event, partial: Partial<AiConfig>): Promise<void> => {
    const ctx = getCtx();
    requireAppContextServices(ctx, ["projectConfigService"] as const);
    const snapshot = ctx.projectConfigService.get();
    const currentAi = snapshot.shared?.ai ?? {};
    const merged = mergeAiConfig(currentAi, partial) ?? {};
    ctx.projectConfigService.save({
      shared: { ...snapshot.shared, ai: merged },
      local: snapshot.local ?? {},
    });
    void ctx.agentChatService?.refreshScheduledWork();
  });

  ipcMain.handle(IPC.projectSecretsList, async (): Promise<ProjectSecretsListResult> => {
    const ctx = getCtx();
    requireAppContextServices(ctx, ["projectSecretService"] as const);
    return ctx.projectSecretService.list();
  });

  ipcMain.handle(IPC.projectSecretsGet, async (_event, arg: ProjectSecretGetArgs): Promise<ProjectSecretValueResult> => {
    const ctx = getCtx();
    requireAppContextServices(ctx, ["projectSecretService"] as const);
    return ctx.projectSecretService.get(arg);
  });

  ipcMain.handle(IPC.projectSecretsSet, async (_event, arg: ProjectSecretSetArgs): Promise<ProjectSecretSummary> => {
    const ctx = getCtx();
    requireAppContextServices(ctx, ["projectSecretService"] as const);
    return ctx.projectSecretService.set(arg);
  });

  ipcMain.handle(IPC.projectSecretsDelete, async (_event, arg: ProjectSecretDeleteArgs): Promise<{ deleted: boolean; name: string }> => {
    const ctx = getCtx();
    requireAppContextServices(ctx, ["projectSecretService"] as const);
    return ctx.projectSecretService.delete(arg);
  });

  ipcMain.handle(IPC.projectSecretsChooseEnvFile, async (event): Promise<ProjectSecretEnvFile | null> => {
    const win = BrowserWindow.fromWebContents(event.sender) ?? undefined;
    const options: Electron.OpenDialogOptions = {
      title: "Import ADE secrets from .env",
      defaultPath: app.getPath("home"),
      properties: ["openFile", "showHiddenFiles"],
    };
    const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
    const selectedPath = result.canceled ? null : result.filePaths[0];
    if (!selectedPath) return null;
    const stat = await fs.promises.stat(selectedPath);
    if (!stat.isFile()) throw new Error("Select a .env file to import.");
    if (stat.size > PROJECT_SECRET_ENV_MAX_BYTES) throw new Error("The selected .env file is larger than 1 MB.");
    return {
      fileName: path.basename(selectedPath),
      content: await fs.promises.readFile(selectedPath, "utf8"),
    };
  });

  ipcMain.handle(IPC.projectSecretsPreviewEnvImport, async (_event, arg: ProjectSecretEnvFile): Promise<ProjectSecretsImportPreview> => {
    const ctx = getCtx();
    requireAppContextServices(ctx, ["projectSecretService"] as const);
    return ctx.projectSecretService.previewEnvImport(arg);
  });

  ipcMain.handle(IPC.projectSecretsImportEnv, async (_event, arg: ProjectSecretsImportArgs): Promise<ProjectSecretsImportResult> => {
    const ctx = getCtx();
    requireAppContextServices(ctx, ["projectSecretService"] as const);
    return ctx.projectSecretService.importEnv(arg);
  });

  ipcMain.handle(IPC.projectSecretsExportEnv, async (): Promise<ProjectSecretsExportResult> => {
    const ctx = getCtx();
    requireAppContextServices(ctx, ["projectSecretService"] as const);
    return ctx.projectSecretService.exportEnv();
  });

  ipcMain.handle(IPC.aiCursorCloudListRepositories, async (): Promise<CursorCloudRepository[]> => {
    const ctx = getCtx();
    requireAppContextServices(ctx, ["aiIntegrationService"] as const);
    return ctx.aiIntegrationService.listCursorCloudRepositories();
  });

  ipcMain.handle(
    IPC.aiCursorCloudListAgents,
    async (_event, arg: { includeArchived?: boolean; limit?: number; cursor?: string | null }): Promise<CursorCloudListAgentsResult> => {
      const ctx = getCtx();
      requireAppContextServices(ctx, ["aiIntegrationService"] as const);
      return ctx.aiIntegrationService.listCursorCloudAgents(arg);
    },
  );

  ipcMain.handle(
    IPC.aiCursorCloudListRuns,
    async (_event, arg: { agentId: string; limit?: number; cursor?: string | null }): Promise<CursorCloudListRunsResult> => {
      const ctx = getCtx();
      requireAppContextServices(ctx, ["aiIntegrationService"] as const);
      return ctx.aiIntegrationService.listCursorCloudRuns(arg);
    },
  );

  ipcMain.handle(
    IPC.aiCursorCloudCreateRun,
    async (_event, arg: CursorCloudCreateRunRequest): Promise<CursorCloudCreateRunResult> => {
      const ctx = getCtx();
      requireAppContextServices(ctx, ["aiIntegrationService"] as const);
      return ctx.aiIntegrationService.createCursorCloudRun(arg);
    },
  );

  ipcMain.handle(IPC.aiCursorCloudArchiveAgent, async (_event, arg: { agentId: string }): Promise<void> => {
    const ctx = getCtx();
    requireAppContextServices(ctx, ["aiIntegrationService"] as const);
    await ctx.aiIntegrationService.archiveCursorCloudAgent(arg.agentId);
  });

  ipcMain.handle(IPC.aiCursorCloudUnarchiveAgent, async (_event, arg: { agentId: string }): Promise<void> => {
    const ctx = getCtx();
    requireAppContextServices(ctx, ["aiIntegrationService"] as const);
    await ctx.aiIntegrationService.unarchiveCursorCloudAgent(arg.agentId);
  });

  ipcMain.handle(IPC.aiCursorCloudDeleteAgent, async (_event, arg: { agentId: string }): Promise<void> => {
    const ctx = getCtx();
    requireAppContextServices(ctx, ["aiIntegrationService"] as const);
    await ctx.aiIntegrationService.deleteCursorCloudAgent(arg.agentId);
  });

  ipcMain.handle(
    IPC.aiCursorCloudGetAgent,
    async (_event, arg: { agentId: string }): Promise<CursorCloudAgentSummary | null> => {
      const ctx = getCtx();
      requireAppContextServices(ctx, ["aiIntegrationService"] as const);
      return await ctx.aiIntegrationService.getCursorCloudAgent(arg.agentId);
    },
  );

  ipcMain.handle(
    IPC.aiCursorCloudListArtifacts,
    async (_event, arg: { agentId: string }): Promise<CursorCloudArtifactSummary[]> => {
      const ctx = getCtx();
      requireAppContextServices(ctx, ["aiIntegrationService"] as const);
      const items = await ctx.aiIntegrationService.listCursorCloudArtifacts(arg.agentId);
      return items.map((entry) => ({
        path: entry.path,
        ...(typeof entry.sizeBytes === "number" ? { sizeBytes: entry.sizeBytes } : {}),
        ...(entry.updatedAt !== undefined ? { updatedAt: entry.updatedAt } : {}),
        ...(entry.mimeType !== undefined ? { mimeType: entry.mimeType } : {}),
      }));
    },
  );

  ipcMain.handle(
    IPC.aiCursorCloudDownloadArtifact,
    async (_event, arg: { agentId: string; path: string }): Promise<CursorCloudArtifactDownload> => {
      const ctx = getCtx();
      requireAppContextServices(ctx, ["aiIntegrationService"] as const);
      return await ctx.aiIntegrationService.downloadCursorCloudArtifact(arg);
    },
  );

  ipcMain.handle(
    IPC.aiCursorCloudCancelRun,
    async (_event, arg: { agentId: string; runId: string }): Promise<void> => {
      const ctx = getCtx();
      requireAppContextServices(ctx, ["agentChatService"] as const);
      await ctx.agentChatService.cancelCursorCloudRun(arg);
    },
  );

  ipcMain.handle(
    IPC.aiCursorCloudFollowUp,
    async (_event, arg: CursorCloudFollowUpRequest): Promise<CursorCloudFollowUpResult> => {
      const ctx = getCtx();
      requireAppContextServices(ctx, ["agentChatService"] as const);
      return await ctx.agentChatService.cursorCloudFollowUp(arg);
    },
  );

  ipcMain.handle(
    IPC.aiCursorCloudOpenChat,
    async (_event, arg: CursorCloudOpenChatRequest): Promise<CursorCloudOpenChatResult> => {
      const ctx = getCtx();
      requireAppContextServices(ctx, ["agentChatService"] as const);
      return await ctx.agentChatService.openCursorCloudChat({
        cloudAgentId: arg.cloudAgentId,
        laneId: arg.laneId,
      });
    },
  );

  ipcMain.handle(
    IPC.aiCursorCloudStreamRun,
    async (_event, arg: unknown): Promise<CursorCloudStreamRunResult> => {
      // Subscription is opportunistic: events flow through the existing session
      // IPC channel as soon as the worker bridge is alive. The returned
      // subscriptionId is an opaque correlation token only — it carries no
      // routing semantics and the renderer cannot demultiplex concurrent runs
      // by it.
      const record = (arg ?? {}) as Record<string, unknown>;
      const agentId = typeof record.agentId === "string" ? record.agentId.trim() : "";
      const runId = typeof record.runId === "string" ? record.runId.trim() : "";
      if (!agentId || !runId) {
        throw new Error("Cursor Cloud stream request requires agentId and runId.");
      }
      return { subscriptionId: `cursor-cloud-stream-${agentId}-${runId}` };
    },
  );

  ipcMain.handle(IPC.syncGetStatus, async (event, arg?: SyncGetStatusArgs): Promise<SyncRoleSnapshot> => {
    const params = {
      includeTransferReadiness: arg?.includeTransferReadiness === true,
      forceTransferReadiness: arg?.forceTransferReadiness === true,
    };
    const runtimeStatus = await tryRuntimeSync<SyncRoleSnapshot>(
      event,
      "sync.getStatus",
      params,
      (pool, rootPath) => pool.syncStatusForRoot(rootPath, arg ?? {}),
    );
    if (runtimeStatus.handled) return runtimeStatus.result;
    const service = await resolveOptionalSyncService();
    if (!service) {
      throw new Error("Sync service is not available.");
    }
    return await service.getStatus({
      includeTransferReadiness: arg?.includeTransferReadiness,
      forceTransferReadiness: arg?.forceTransferReadiness,
    });
  });

  ipcMain.handle(IPC.syncRefreshDiscovery, async (event): Promise<SyncRoleSnapshot> => {
    const runtimeStatus = await tryRuntimeSync<SyncRoleSnapshot>(
      event,
      "sync.refreshDiscovery",
      {},
      (pool, rootPath) => pool.refreshSyncDiscoveryForRoot(rootPath),
    );
    if (runtimeStatus.handled) return runtimeStatus.result;
    return await (await requireSyncService()).refreshDiscovery();
  });

  ipcMain.handle(IPC.syncListDevices, async (event): Promise<SyncDeviceRuntimeState[]> => {
    const runtimeDevices = await tryRuntimeSync<SyncDeviceRuntimeState[]>(
      event,
      "sync.listDevices",
      {},
      (pool, rootPath) => pool.syncDevicesForRoot(rootPath),
    );
    if (runtimeDevices.handled) return runtimeDevices.result;
    return await (await requireSyncService()).listDevices();
  });

  ipcMain.handle(
    IPC.syncUpdateLocalDevice,
    async (
      event,
      arg: { name?: string; deviceType?: SyncPeerDeviceType },
    ): Promise<SyncDeviceRecord> => {
      const params = {
        name: typeof arg?.name === "string" ? arg.name : undefined,
        deviceType: arg?.deviceType,
      };
      const runtimeDevice = await tryRuntimeSync<SyncDeviceRecord>(
        event,
        "sync.updateLocalDevice",
        params,
        (pool, rootPath) => pool.updateSyncLocalDeviceForRoot(rootPath, params),
      );
      if (runtimeDevice.handled) return runtimeDevice.result;
      return await (await requireSyncService()).updateLocalDevice(params);
    },
  );

  ipcMain.handle(
    IPC.syncConnectToBrain,
    async (event, arg: SyncDesktopConnectionDraft): Promise<SyncRoleSnapshot> => {
      const params = (arg ?? {}) as unknown as Record<string, unknown>;
      const runtimeStatus = await tryRuntimeSync<SyncRoleSnapshot>(
        event,
        "sync.connectToBrain",
        params,
        (pool, rootPath) => pool.callSyncForRoot<SyncRoleSnapshot>(
          rootPath,
          "sync.connectToBrain",
          params,
        ),
      );
      if (runtimeStatus.handled) return runtimeStatus.result;
      return await (await requireSyncService()).connectToBrain(arg);
    },
  );

  ipcMain.handle(IPC.syncDisconnectFromBrain, async (event): Promise<SyncRoleSnapshot> => {
    const runtimeStatus = await tryRuntimeSync<SyncRoleSnapshot>(
      event,
      "sync.disconnectFromBrain",
      {},
      (pool, rootPath) => pool.callSyncForRoot<SyncRoleSnapshot>(rootPath, "sync.disconnectFromBrain"),
    );
    if (runtimeStatus.handled) return runtimeStatus.result;
    return await (await requireSyncService()).disconnectFromBrain();
  });

  ipcMain.handle(IPC.syncForgetDevice, async (event, arg: { deviceId: string }): Promise<SyncRoleSnapshot> => {
    const deviceId = typeof arg?.deviceId === "string" ? arg.deviceId : "";
    const runtimeStatus = await tryRuntimeSync<SyncRoleSnapshot>(
      event,
      "sync.forgetDevice",
      { deviceId },
      (pool, rootPath) => pool.forgetSyncDeviceForRoot(rootPath, deviceId),
    );
    if (runtimeStatus.handled) return runtimeStatus.result;
    return await (await requireSyncService()).forgetDevice(deviceId);
  });

  ipcMain.handle(IPC.syncGetTransferReadiness, async (event): Promise<SyncTransferReadiness> => {
    const runtimeReadiness = await tryRuntimeSync<SyncTransferReadiness>(
      event,
      "sync.getTransferReadiness",
      {},
      (pool, rootPath) => pool.callSyncForRoot<SyncTransferReadiness>(rootPath, "sync.getTransferReadiness"),
    );
    if (runtimeReadiness.handled) return runtimeReadiness.result;
    return await (await requireSyncService()).getTransferReadiness();
  });

  ipcMain.handle(IPC.syncTransferBrainToLocal, async (event): Promise<SyncRoleSnapshot> => {
    const runtimeStatus = await tryRuntimeSync<SyncRoleSnapshot>(
      event,
      "sync.transferBrainToLocal",
      {},
      (pool, rootPath) => pool.callSyncForRoot<SyncRoleSnapshot>(rootPath, "sync.transferBrainToLocal"),
    );
    if (runtimeStatus.handled) return runtimeStatus.result;
    return await (await requireSyncService()).transferBrainToLocal();
  });

  ipcMain.handle(IPC.syncGetPin, async (event): Promise<{ pin: string | null }> => {
    const runtimePin = await tryRuntimeSync<{ pin: string | null }>(
      event,
      "sync.getPin",
      {},
      (pool, rootPath) => pool.syncPinForRoot(rootPath),
    );
    if (runtimePin.handled) return runtimePin.result;
    return { pin: (await requireSyncService()).getPin() };
  });

  ipcMain.handle(IPC.syncSetPin, async (event, pin: string): Promise<SyncRoleSnapshot> => {
    const normalizedPin = typeof pin === "string" ? pin : "";
    const runtimeStatus = await tryRuntimeSync<SyncRoleSnapshot>(
      event,
      "sync.setPin",
      { pin: normalizedPin },
      (pool, rootPath) => pool.setSyncPinForRoot(rootPath, normalizedPin),
    );
    if (runtimeStatus.handled) return runtimeStatus.result;
    return await (await requireSyncService()).setPin(normalizedPin);
  });

  ipcMain.handle(IPC.syncGeneratePin, async (event): Promise<SyncRoleSnapshot> => {
    const runtimeStatus = await tryRuntimeSync<SyncRoleSnapshot>(
      event,
      "sync.generatePin",
      {},
      (pool, rootPath) => pool.generateSyncPinForRoot(rootPath),
    );
    if (runtimeStatus.handled) return runtimeStatus.result;
    return await (await requireSyncService()).generatePin();
  });

  ipcMain.handle(IPC.syncClearPin, async (event): Promise<SyncRoleSnapshot> => {
    const runtimeStatus = await tryRuntimeSync<SyncRoleSnapshot>(
      event,
      "sync.clearPin",
      {},
      (pool, rootPath) => pool.clearSyncPinForRoot(rootPath),
    );
    if (runtimeStatus.handled) return runtimeStatus.result;
    return await (await requireSyncService()).clearPin();
  });

  ipcMain.handle(IPC.syncGetRuntimeName, async (event): Promise<{ runtimeName: string | null }> => {
    const runtimeName = await tryRuntimeSync<{ runtimeName: string | null }>(
      event,
      "sync.getRuntimeName",
      {},
      (pool, rootPath) => pool.syncRuntimeNameForRoot(rootPath),
    );
    if (runtimeName.handled) return runtimeName.result;
    return { runtimeName: (await requireSyncService()).getRuntimeName() };
  });

  ipcMain.handle(IPC.syncSetRuntimeName, async (event, name: string): Promise<SyncRoleSnapshot> => {
    const normalizedName = typeof name === "string" ? name : "";
    const runtimeStatus = await tryRuntimeSync<SyncRoleSnapshot>(
      event,
      "sync.setRuntimeName",
      { name: normalizedName },
      (pool, rootPath) => pool.setSyncRuntimeNameForRoot(rootPath, normalizedName),
    );
    if (runtimeStatus.handled) return runtimeStatus.result;
    return await (await requireSyncService()).setRuntimeName(normalizedName);
  });

  ipcMain.handle(IPC.syncClearRuntimeName, async (event): Promise<SyncRoleSnapshot> => {
    const runtimeStatus = await tryRuntimeSync<SyncRoleSnapshot>(
      event,
      "sync.clearRuntimeName",
      {},
      (pool, rootPath) => pool.clearSyncRuntimeNameForRoot(rootPath),
    );
    if (runtimeStatus.handled) return runtimeStatus.result;
    return await (await requireSyncService()).clearRuntimeName();
  });

  ipcMain.handle(
    IPC.syncSetActiveLanePresence,
    async (event, arg: { laneIds?: string[] | null }): Promise<void> => {
      const laneIds = Array.isArray(arg?.laneIds) ? arg.laneIds : [];
      const runtimeResult = await tryRuntimeSync<{ ok: true }>(
        event,
        "sync.setActiveLanePresence",
        { laneIds },
        async (pool, rootPath) => {
          await pool.callSyncForRoot(rootPath, "sync.setActiveLanePresence", { laneIds });
          return { ok: true };
        },
      );
      if (runtimeResult.handled) {
        return;
      }
      const service = await resolveOptionalSyncService();
      if (!service) {
        throw new Error("Sync service is not available.");
      }
      await service.setActiveLanePresence(laneIds);
    },
  );

  ipcMain.handle(IPC.syncGetCloudRelayStatus, async (event): Promise<SyncCloudRelayStatus> => {
    const runtimeResult = await tryRuntimeSync<SyncCloudRelayStatus>(
      event,
      "sync.getCloudRelayStatus",
      {},
      (pool, rootPath) => pool.syncCloudRelayStatusForRoot(rootPath),
    );
    if (runtimeResult.handled) return runtimeResult.result;
    return (await requireSyncService()).getCloudRelayStatus();
  });

  ipcMain.handle(IPC.agentToolsDetect, async (): Promise<AgentTool[]> => {
    const ctx = getCtx();
    requireAppContextServices(ctx, ["agentToolsService"] as const);
    return ctx.agentToolsService.detect();
  });

  ipcMain.handle(IPC.adeCliGetStatus, async () => {
    const ctx = getCtx();
    return ctx.adeCliService.getStatus();
  });

  ipcMain.handle(IPC.adeCliInstallForUser, async () => {
    const ctx = getCtx();
    return ctx.adeCliService.installForUser();
  });

  ipcMain.handle(IPC.devToolsDetect, async (_event: unknown, arg?: { force?: boolean }) => {
    const ctx = getCtx();
    if (!ctx.devToolsService) {
      const result: DevToolsCheckResult = {
        platform: process.platform,
        tools: [
          {
            id: "git",
            label: "Git",
            command: "git",
            installed: false,
            detectedPath: null,
            detectedVersion: null,
            required: true,
          },
        ],
      };
      return result;
    }
    return ctx.devToolsService.detect(arg?.force);
  });

  ipcMain.handle(IPC.onboardingGetStatus, async (): Promise<OnboardingStatus> => {
    const ctx = getCtx();
    if (!ctx.onboardingService) {
      return { completedAt: null, dismissedAt: null };
    }
    return ctx.onboardingService.getStatus();
  });

  ipcMain.handle(IPC.onboardingDetectDefaults, async (): Promise<OnboardingDetectionResult> => {
    const ctx = getCtx();
    if (!ctx.onboardingService) {
      return {
        projectTypes: [],
        indicators: [],
        suggestedConfig: {
          version: 1,
          processes: [],
          stackButtons: [],
          testSuites: [],
          laneOverlayPolicies: [],
          automations: []
        },
        suggestedWorkflows: []
      };
    }
    return await ctx.onboardingService.detectDefaults();
  });

  ipcMain.handle(IPC.onboardingDetectExistingLanes, async (): Promise<OnboardingExistingLaneCandidate[]> => {
    const ctx = getCtx();
    if (!ctx.onboardingService) return [];
    return await ctx.onboardingService.detectExistingLanes();
  });

  ipcMain.handle(IPC.onboardingSetDismissed, async (_event, arg: { dismissed: boolean }): Promise<OnboardingStatus> => {
    const ctx = getCtx();
    if (!ctx.onboardingService) {
      return { completedAt: null, dismissedAt: arg.dismissed ? new Date().toISOString() : null };
    }
    return ctx.onboardingService.setDismissed(arg.dismissed);
  });

  ipcMain.handle(IPC.onboardingComplete, async (): Promise<OnboardingStatus> => {
    const ctx = getCtx();
    if (!ctx.onboardingService) {
      return { completedAt: null, dismissedAt: null };
    }
    return ctx.onboardingService.complete();
  });

  const emptyHelpState = (): OnboardingHelpState => ({ glossaryTermsSeen: [] });

  ipcMain.handle(
    IPC.onboardingMarkGlossaryTermSeen,
    async (_event, arg: { termId: string }): Promise<OnboardingHelpState> => {
      const ctx = getCtx();
      if (!ctx.onboardingService) return emptyHelpState();
      return ctx.onboardingService.markGlossaryTermSeen(arg?.termId ?? "");
    },
  );

  const ensureAutomationContext = (): AppContextWith<"automationService"> => {
    const ctx = getCtx();
    requireAppContextServices(ctx, ["automationService"] as const);
    return ctx;
  };

  const ensureAutomationPlannerContext = (): AppContextWith<"automationPlannerService"> => {
    const ctx = getCtx();
    requireAppContextServices(ctx, ["automationPlannerService"] as const);
    return ctx;
  };

  const ensureReviewContext = (): AppContextWith<"reviewService"> => {
    const ctx = getCtx();
    requireAppContextServices(ctx, ["reviewService"] as const);
    return ctx;
  };

  ipcMain.handle(IPC.automationsList, async (): Promise<AutomationRuleSummary[]> => {
    const ctx = ensureAutomationContext();
    return ctx.automationService.list();
  });

  ipcMain.handle(IPC.automationsToggle, async (_event, arg: { id: string; enabled: boolean }): Promise<AutomationRuleSummary[]> => {
    const ctx = ensureAutomationContext();
    return ctx.automationService.toggle({ id: arg?.id ?? "", enabled: Boolean(arg?.enabled) });
  });

  ipcMain.handle(IPC.automationsDeleteRule, async (_event, arg: { id: string }): Promise<AutomationRuleSummary[]> => {
    const ctx = ensureAutomationContext();
    return ctx.automationService.deleteRule({ id: arg?.id ?? "" });
  });

  ipcMain.handle(IPC.automationsTriggerManually, async (_event, arg: AutomationManualTriggerRequest): Promise<AutomationRun> => {
    const ctx = ensureAutomationContext();
    return await ctx.automationService.triggerManually({
      id: arg?.id ?? "",
      laneId: arg?.laneId ?? null,
      reviewProfileOverride: arg?.reviewProfileOverride ?? null,
      verboseTrace: Boolean(arg?.verboseTrace),
      dryRun: Boolean(arg?.dryRun),
    });
  });

  ipcMain.handle(IPC.automationsGetHistory, async (_event, arg: { id: string; limit?: number }): Promise<AutomationRun[]> => {
    const ctx = ensureAutomationContext();
    return ctx.automationService.getHistory({ id: arg?.id ?? "", limit: arg?.limit });
  });

  ipcMain.handle(IPC.automationsListRuns, async (_event, arg: AutomationRunListArgs = {}): Promise<AutomationRun[]> => {
    const ctx = ensureAutomationContext();
    return ctx.automationService.listRuns(arg);
  });

  ipcMain.handle(IPC.automationsGetRunDetail, async (_event, arg: { runId: string }): Promise<AutomationRunDetail | null> => {
    const ctx = ensureAutomationContext();
    return ctx.automationService.getRunDetail({ runId: arg?.runId ?? "" });
  });

  ipcMain.handle(IPC.automationsGetIngressStatus, async (): Promise<AutomationIngressStatus> => {
    const ctx = ensureAutomationContext();
    return ctx.automationService.getIngressStatus();
  });

  ipcMain.handle(IPC.automationsRefreshWebhookGatewayStatus, async (): Promise<AutomationIngressStatus["webhookGateway"]> => {
    const ctx = ensureAutomationContext();
    return await ctx.automationService.refreshWebhookGatewayStatus();
  });

  ipcMain.handle(IPC.automationsSetWebhookGatewayPublicUrl, async (_event, arg: { publicUrl?: string | null } | undefined): Promise<AutomationIngressStatus["webhookGateway"]> => {
    const ctx = ensureAutomationContext();
    return await ctx.automationService.setWebhookGatewayPublicUrl(arg ?? {});
  });

  ipcMain.handle(IPC.automationsListIngressEvents, async (_event, arg: { limit?: number } | undefined): Promise<AutomationIngressEventRecord[]> => {
    const ctx = ensureAutomationContext();
    return ctx.automationService.listIngressEvents(arg?.limit);
  });

  ipcMain.handle(IPC.automationsParseNaturalLanguage, async (_event, arg: AutomationParseNaturalLanguageRequest): Promise<AutomationParseNaturalLanguageResult> => {
    const ctx = ensureAutomationPlannerContext();
    return await ctx.automationPlannerService.parseNaturalLanguage(arg);
  });

  ipcMain.handle(IPC.automationsValidateDraft, async (_event, arg: AutomationValidateDraftRequest): Promise<AutomationValidateDraftResult> => {
    const ctx = ensureAutomationPlannerContext();
    return ctx.automationPlannerService.validateDraft(arg);
  });

  ipcMain.handle(IPC.automationsSaveDraft, async (_event, arg: AutomationSaveDraftRequest): Promise<AutomationSaveDraftResult> => {
    const ctx = ensureAutomationPlannerContext();
    return ctx.automationPlannerService.saveDraft(arg);
  });

  ipcMain.handle(IPC.automationsSimulate, async (_event, arg: AutomationSimulateRequest): Promise<AutomationSimulateResult> => {
    const ctx = ensureAutomationPlannerContext();
    return ctx.automationPlannerService.simulate(arg);
  });

  ipcMain.handle(IPC.automationsListScheduledCleanups, async (): Promise<AutomationScheduledCleanup[]> => {
    const ctx = ensureAutomationContext();
    return ctx.automationService.listScheduledCleanups();
  });

  ipcMain.handle(IPC.automationsCancelScheduledCleanup, async (_event, arg: { id: string }): Promise<boolean> => {
    const ctx = ensureAutomationContext();
    return ctx.automationService.cancelScheduledCleanup(arg.id);
  });

  const ensureLinearIngressContext = (): AppContextWith<"linearIngressService"> => {
    const ctx = getCtx();
    requireAppContextServices(ctx, ["linearIngressService"] as const);
    return ctx;
  };

  ipcMain.handle(IPC.automationsLinearIngressGetStatus, async (): Promise<LinearIngressStatus> => {
    const ctx = ensureLinearIngressContext();
    return ctx.linearIngressService.getStatus();
  });

  ipcMain.handle(IPC.automationsLinearIngressSetup, async (): Promise<LinearIngressStatus> => {
    const ctx = ensureLinearIngressContext();
    return ctx.linearIngressService.setup();
  });

  ipcMain.handle(IPC.automationsLinearIngressTeardown, async (): Promise<LinearIngressStatus> => {
    const ctx = ensureLinearIngressContext();
    return ctx.linearIngressService.teardown();
  });

  ipcMain.handle(IPC.automationsLinearIngressPollNow, async (): Promise<LinearIngressStatus> => {
    const ctx = ensureLinearIngressContext();
    await ctx.linearIngressService.pollNow();
    return ctx.linearIngressService.getStatus();
  });

  ipcMain.handle(IPC.reviewListLaunchContext, async (): Promise<ReviewLaunchContext> => {
    const ctx = ensureReviewContext();
    return ctx.reviewService.listLaunchContext();
  });

  ipcMain.handle(IPC.reviewListRuns, async (_event, arg: ReviewListRunsArgs = {}): Promise<ReviewRun[]> => {
    const ctx = ensureReviewContext();
    return ctx.reviewService.listRuns(arg);
  });

  ipcMain.handle(IPC.reviewGetRunDetail, async (_event, arg: { runId: string }): Promise<ReviewRunDetail | null> => {
    const ctx = ensureReviewContext();
    return ctx.reviewService.getRunDetail({ runId: arg?.runId ?? "" });
  });

  ipcMain.handle(IPC.reviewStartRun, async (_event, arg: ReviewStartRunArgs): Promise<ReviewRun> => {
    const ctx = ensureReviewContext();
    return ctx.reviewService.startRun(arg);
  });

  ipcMain.handle(IPC.reviewRerun, async (_event, arg: { runId: string }): Promise<ReviewRun> => {
    const ctx = ensureReviewContext();
    return ctx.reviewService.rerun(arg?.runId ?? "");
  });

  ipcMain.handle(IPC.reviewCancelRun, async (_event, arg: { runId: string }) => {
    const ctx = ensureReviewContext();
    return ctx.reviewService.cancelRun({ runId: arg?.runId ?? "" });
  });

  ipcMain.handle(IPC.reviewRecordFeedback, async (_event, arg: import("../../../shared/types").ReviewRecordFeedbackArgs) => {
    const ctx = ensureReviewContext();
    return ctx.reviewService.recordFeedback(arg);
  });

  ipcMain.handle(IPC.reviewListSuppressions, async (_event, arg: import("../../../shared/types").ReviewListSuppressionsArgs | undefined) => {
    const ctx = ensureReviewContext();
    return ctx.reviewService.listSuppressions(arg ?? {});
  });

  ipcMain.handle(IPC.reviewDeleteSuppression, async (_event, arg: { suppressionId: string }) => {
    const ctx = ensureReviewContext();
    return ctx.reviewService.deleteSuppression({ suppressionId: arg?.suppressionId ?? "" });
  });

  ipcMain.handle(IPC.reviewQualityReport, async () => {
    const ctx = ensureReviewContext();
    return ctx.reviewService.qualityReport();
  });

  ipcMain.handle(IPC.adeActionsListRegistry, async (): Promise<AdeActionRegistryEntry[]> => {
    const ctx = getCtx();
    const services = getAdeActionDomainServices(ctx as unknown as AdeRuntime);
    const entries: AdeActionRegistryEntry[] = [];
    for (const domain of Object.keys(ADE_ACTION_ALLOWLIST) as Array<keyof typeof ADE_ACTION_ALLOWLIST>) {
      const service = services[domain];
      if (!service) continue;
      const actionNames = listAllowedAdeActionNames(domain, service as Record<string, unknown>);
      if (actionNames.length === 0) continue;
      entries.push({
        domain,
        actions: actionNames.map((name) => ({ name })),
      });
    }
    entries.sort((a, b) => a.domain.localeCompare(b.domain));
    return entries;
  });

  const normalizeExternalSessionListArgs = (arg: unknown): ExternalSessionListArgs => {
    const record = isRecord(arg) ? arg as Record<string, unknown> : {};
    return {
      ...(Array.isArray(record.providers) ? { providers: record.providers as ExternalSessionListArgs["providers"] } : {}),
      ...(typeof record.laneId === "string" || record.laneId === null ? { laneId: record.laneId } : {}),
      ...(typeof record.cwd === "string" || record.cwd === null ? { cwd: record.cwd } : {}),
      ...(record.scope === "all" || record.scope === "project" ? { scope: record.scope } : {}),
      ...(typeof record.limit === "number" ? { limit: record.limit } : {}),
    };
  };

  const normalizeExternalSessionImportArgs = (arg: unknown): ExternalSessionImportArgs => {
    if (!isRecord(arg)) throw new Error("external session import expects an object payload.");
    const record = arg as Record<string, unknown>;
    const { provider, target, mode } = record;
    if (provider !== "claude" && provider !== "codex" && provider !== "cursor" && provider !== "droid" && provider !== "opencode") {
      throw new Error("external session import provider is invalid.");
    }
    if (target !== "cli" && target !== "chat") throw new Error("external session import target must be cli or chat.");
    if (mode !== "resume" && mode !== "fork") throw new Error("external session import mode must be resume or fork.");
    if (typeof record.sessionId !== "string") throw new Error("external session import sessionId must be a string.");
    if (typeof record.laneId !== "string") throw new Error("external session import laneId must be a string.");
    return {
      provider,
      sessionId: record.sessionId,
      laneId: record.laneId,
      target,
      mode,
      ...(typeof record.model === "string" ? { model: record.model } : {}),
      ...(typeof record.permissionMode === "string" ? { permissionMode: record.permissionMode } : {}),
    };
  };

  ipcMain.handle(IPC.externalSessionsList, async (_event, arg: unknown): Promise<ExternalSessionSummary[]> => {
    const ctx = getCtx();
    requireAppContextServices(ctx, ["externalSessionsService"]);
    return ctx.externalSessionsService.list(normalizeExternalSessionListArgs(arg));
  });

  ipcMain.handle(IPC.externalSessionsImport, async (_event, arg: unknown): Promise<ExternalSessionImportResult> => {
    const ctx = getCtx();
    requireAppContextServices(ctx, ["externalSessionsService"]);
    return ctx.externalSessionsService.importExternalSession(normalizeExternalSessionImportArgs(arg));
  });


  // ── Usage tracking + budget cap IPC ──────────────────────────
  ipcMain.handle(IPC.usageGetAdeStats, async (_event, arg: GetAdeUsageStatsArgs | undefined): Promise<AdeUsageStats | null> => {
    const ctx = getCtx();
    if (arg != null && !isRecord(arg)) throw new Error("usage stats expects an object payload.");
    if (arg?.preset != null && !isAdeUsageRangePreset(arg.preset)) {
      throw new Error("usage stats preset must be today, 7d, 30d, year, or all.");
    }
    if (arg?.scope != null && !isAdeUsageScope(arg.scope)) {
      throw new Error("usage stats scope must be machine or project.");
    }
    if (arg?.since != null && Number.isNaN(Date.parse(arg.since))) {
      throw new Error("usage stats since must be an ISO timestamp.");
    }
    if (arg?.until != null && Number.isNaN(Date.parse(arg.until))) {
      throw new Error("usage stats until must be an ISO timestamp.");
    }
    return ctx.usageTrackingService?.getAdeUsageStats(arg ?? {}) ?? null;
  });

  ipcMain.handle(IPC.usageGetSnapshot, async (): Promise<UsageSnapshot | null> => {
    const ctx = getCtx();
    return ctx.usageTrackingService?.getUsageSnapshot() ?? null;
  });

  ipcMain.handle(IPC.usageRefresh, async (): Promise<UsageSnapshot | null> => {
    const ctx = getCtx();
    return (await ctx.usageTrackingService?.forceRefresh()) ?? null;
  });

  ipcMain.handle(IPC.usageRefreshHistory, async (): Promise<UsageSnapshot | null> => {
    const ctx = getCtx();
    return (await ctx.usageTrackingService?.refreshHistory()) ?? null;
  });

  ipcMain.handle(IPC.usageNoteDemand, async (): Promise<UsageSnapshot | null> => {
    const ctx = getCtx();
    return ctx.usageTrackingService?.noteQuotaDemand() ?? null;
  });

  ipcMain.handle(
    IPC.usageCheckBudget,
    async (
      _event,
      arg: BudgetCheckArgs
    ): Promise<BudgetCheckResult> => {
      const ctx = getCtx();
      if (!ctx.budgetCapService) {
        return { allowed: true, warnings: [] };
      }
      return ctx.budgetCapService.checkBudget(arg.scope, arg.scopeId ?? "all", arg.provider, {
        runScopeId: arg.runScopeId,
      });
    }
  );

  ipcMain.handle(
    IPC.usageGetCumulativeUsage,
    async (
      _event,
      arg: { scope: BudgetCapScope; scopeId?: string; provider?: BudgetCapProvider }
    ): Promise<{ totalTokens: number; totalCostUsd: number; weekKey: string }> => {
      const ctx = getCtx();
      if (!ctx.budgetCapService) {
        return { totalTokens: 0, totalCostUsd: 0, weekKey: "" };
      }
      return ctx.budgetCapService.getCumulativeUsage(
        arg.scope,
        arg.scopeId ?? "all",
        arg.provider ?? "any"
      );
    }
  );

  ipcMain.handle(IPC.usageGetBudgetConfig, async (): Promise<BudgetCapConfig> => {
    const ctx = getCtx();
    return ctx.budgetCapService?.getConfig() ?? {};
  });

  ipcMain.handle(IPC.usageSaveBudgetConfig, async (_event, arg: BudgetCapConfig): Promise<BudgetCapConfig> => {
    const ctx = getCtx();
    return ctx.budgetCapService?.updateConfig(arg ?? {}) ?? {};
  });

  const ensureDbContext = (): AppContextWith<"db"> => {
    const ctx = getCtx();
    requireAppContextServices(ctx, ["db"] as const);
    return ctx;
  };

  ipcMain.handle(IPC.layoutGet, async (_event, arg: { layoutId: string }): Promise<DockLayout | null> => {
    const ctx = ensureDbContext();
    const key = `dock_layout:${arg.layoutId}`;
    const value = ctx.db.getJson<DockLayout>(key);
    return value;
  });

  ipcMain.handle(IPC.layoutSet, async (_event, arg: { layoutId: string; layout: DockLayout }): Promise<void> => {
    const ctx = ensureDbContext();
    const key = `dock_layout:${arg.layoutId}`;
    const safe = clampLayout(arg.layout);
    ctx.db.setJson(key, safe);
    ctx.logger.debug("layout.set", { key, panels: Object.keys(safe).length });
  });

  ipcMain.handle(IPC.tilingTreeGet, async (_event, arg: { layoutId: string }): Promise<unknown> => {
    const ctx = ensureDbContext();
    const key = `tiling_tree:${arg.layoutId}`;
    const value = ctx.db.getJson<unknown>(key);
    return value;
  });

  ipcMain.handle(IPC.tilingTreeSet, async (_event, arg: { layoutId: string; tree: unknown }): Promise<void> => {
    const ctx = ensureDbContext();
    const key = `tiling_tree:${arg.layoutId}`;
    ctx.db.setJson(key, arg.tree);
    ctx.logger.debug("tilingTree.set", { key });
  });

  ipcMain.handle(IPC.graphStateGet, async (_event, arg: { projectId: string }): Promise<GraphPersistedState | null> => {
    const ctx = ensureDbContext();
    const key = `graph_state:${arg.projectId}`;
    return ctx.db.getJson<GraphPersistedState>(key);
  });

  ipcMain.handle(IPC.graphStateSet, async (_event, arg: { projectId: string; state: GraphPersistedState }): Promise<void> => {
    const ctx = ensureDbContext();
    const key = `graph_state:${arg.projectId}`;
    ctx.db.setJson(key, arg.state);
  });

  const ensureLaneContext = (): AppContextWith<"laneService"> => {
    const ctx = getCtx();
    requireAppContextServices(ctx, ["laneService"] as const);
    return ctx;
  };

  ipcMain.handle(IPC.lanesList, async (_event, arg: ListLanesArgs): Promise<LaneSummary[]> => {
    const ctx = ensureLaneContext();
    const devicesOpenByLaneId = buildLanePresenceByLaneId(getOptionalSyncService());
    return await withIpcTiming(
      ctx,
      "lanes.list",
      async () => {
        const lanes = await ctx.laneService.list(arg);
        return decorateLaneSummariesWithPresence(lanes, devicesOpenByLaneId);
      },
      {
        includeArchived: Boolean(arg?.includeArchived),
        includeStatus: arg?.includeStatus !== false
      }
    );
  });

  ipcMain.handle(IPC.lanesListSnapshots, async (_event, arg: ListLanesArgs): Promise<LaneListSnapshot[]> => {
    const ctx = ensureLaneContext();
    requireAppContextServices(ctx, ["sessionService", "ptyService"] as const);
    return await withIpcTiming(
      ctx,
      "lanes.listSnapshots",
      async () => {
        const lanes = await ctx.laneService.list({
          includeArchived: Boolean(arg?.includeArchived),
          includeStatus: arg?.includeStatus !== false,
        });
        return await buildLaneListSnapshots(ctx, lanes, {
          includeConflictStatus: arg?.includeConflictStatus !== false,
          includeRebaseSuggestions: arg?.includeRebaseSuggestions !== false,
          includeAutoRebaseStatus: arg?.includeAutoRebaseStatus !== false,
        });
      },
      {
        includeArchived: Boolean(arg?.includeArchived),
        includeStatus: arg?.includeStatus !== false,
        includeConflictStatus: arg?.includeConflictStatus !== false,
        includeRebaseSuggestions: arg?.includeRebaseSuggestions !== false,
        includeAutoRebaseStatus: arg?.includeAutoRebaseStatus !== false,
      }
    );
  });

  ipcMain.handle(IPC.lanesCreate, async (_event, arg: CreateLaneArgs): Promise<LaneSummary> => {
    const ctx = ensureLaneContext();
    const lane = await ctx.laneService.create({
      name: arg.name,
      description: arg.description,
      parentLaneId: arg.parentLaneId,
      baseBranch: arg.baseBranch,
      branchName: arg.branchName,
      linearIssue: arg.linearIssue ?? null,
    });
    await ensureLanePortLease(ctx, lane.id);
    notifyLaneCreated(ctx, lane);
    return lane;
  });

  ipcMain.handle(IPC.lanesCreateChild, async (_event, arg: CreateChildLaneArgs): Promise<LaneSummary> => {
    const ctx = ensureLaneContext();
    const lane = await ctx.laneService.createChild(arg);
    await ensureLanePortLease(ctx, lane.id);
    notifyLaneCreated(ctx, lane);
    return lane;
  });

  ipcMain.handle(IPC.lanesCreateFromUnstaged, async (_event, arg: CreateLaneFromUnstagedArgs): Promise<LaneSummary> => {
    const ctx = ensureLaneContext();
    const lane = await ctx.laneService.createFromUnstaged(arg);
    await ensureLanePortLease(ctx, lane.id);
    notifyLaneCreated(ctx, lane);
    return lane;
  });

  ipcMain.handle(IPC.lanesImportBranch, async (_event, arg: ImportBranchLaneArgs): Promise<LaneSummary> => {
    const ctx = ensureLaneContext();
    const lane = await ctx.laneService.importBranch(arg);
    await ensureLanePortLease(ctx, lane.id);
    notifyLaneCreated(ctx, lane);
    return lane;
  });

  ipcMain.handle(IPC.lanesPreviewBranchSwitch, async (_event, arg: LaneBranchSwitchArgs): Promise<LaneBranchSwitchPreview> => {
    const ctx = ensureLaneContext();
    return await ctx.laneService.previewBranchSwitch(arg);
  });

  ipcMain.handle(IPC.lanesSwitchBranch, async (_event, arg: LaneBranchSwitchArgs): Promise<LaneBranchSwitchResult> => {
    const ctx = ensureLaneContext();
    return await ctx.laneService.switchBranch(arg);
  });

  ipcMain.handle(IPC.lanesAttach, async (_event, arg: AttachLaneArgs): Promise<LaneSummary> => {
    const ctx = ensureLaneContext();
    const lane = await ctx.laneService.attach(arg);
    invalidateProjectPathInspectionCache();
    await ensureLanePortLease(ctx, lane.id);
    notifyLaneCreated(ctx, lane);
    return lane;
  });

  ipcMain.handle(IPC.lanesListUnregisteredWorktrees, async (): Promise<UnregisteredLaneCandidate[]> => {
    const ctx = ensureLaneContext();
    return ctx.laneService.listUnregisteredWorktrees();
  });

  ipcMain.handle(IPC.lanesAdoptAttached, async (_event, arg: AdoptAttachedLaneArgs): Promise<LaneSummary> => {
    const ctx = ensureLaneContext();
    const lane = await ctx.laneService.adoptAttached(arg);
    await ensureLanePortLease(ctx, lane.id);
    notifyLaneCreated(ctx, lane);
    return lane;
  });

  ipcMain.handle(IPC.lanesRename, async (_event, arg: RenameLaneArgs): Promise<void> => {
    const ctx = ensureLaneContext();
    ctx.laneService.rename(arg);
  });

  ipcMain.handle(IPC.lanesReparent, async (_event, arg: ReparentLaneArgs): Promise<ReparentLaneResult> => {
    const ctx = ensureLaneContext();
    return await ctx.laneService.reparent(arg);
  });

  ipcMain.handle(IPC.lanesUpdateAppearance, async (_event, arg: UpdateLaneAppearanceArgs): Promise<void> => {
    const ctx = ensureLaneContext();
    ctx.laneService.updateAppearance(arg);
  });

  ipcMain.handle(IPC.lanesArchive, async (_event, arg: ArchiveLaneArgs): Promise<void> => {
    const ctx = ensureLaneContext();
    const lane = await ctx.laneService
      .list({ includeArchived: true, includeStatus: false })
      .then((lanes) => lanes.find((entry) => entry.id === arg.laneId) ?? null)
      .catch(() => null);
    ctx.laneService.archive(arg);
    ctx.portAllocationService?.release(arg.laneId);
    if (lane) {
      ctx.automationService?.onLaneArchived?.({
        laneId: lane.id,
        laneName: lane.name,
        branchRef: lane.branchRef,
        folder: lane.folder ?? null,
      });
    }
  });

  ipcMain.handle(IPC.lanesDelete, async (_event, arg: DeleteLaneArgs): Promise<void> => {
    const ctx = ensureLaneContext();
    const envContext = ctx.laneEnvironmentService
      ? await resolveLaneOverlayContext(ctx, arg.laneId).catch((error: unknown) => {
          ctx.logger.warn("lane_env_cleanup.pre_delete_context_failed", {
            laneId: arg.laneId,
            error: getErrorMessage(error)
          });
          return null;
        })
      : null;
    const teardownEnv = ctx.laneEnvironmentService && envContext?.envInitConfig
      ? async () => {
          await ctx.laneEnvironmentService!.cleanupLaneEnvironment(envContext.lane, envContext.envInitConfig);
        }
      : undefined;
    await ctx.laneService.delete(arg, { teardownEnv });
    ctx.portAllocationService?.release(arg.laneId);
  });

  ipcMain.handle(IPC.lanesDeleteCancel, async (_event, arg: { laneId: string }) => {
    const ctx = ensureLaneContext();
    return ctx.laneService.cancelDelete(arg.laneId);
  });

  ipcMain.handle(IPC.lanesListDeleteProgress, async () => {
    const ctx = ensureLaneContext();
    return ctx.laneService.listDeleteProgress();
  });

  ipcMain.handle(IPC.lanesGetDeleteRisk, async (_event, arg: { laneId: string }) => {
    const ctx = ensureLaneContext();
    return await ctx.laneService.getDeleteRisk(arg.laneId);
  });

  ipcMain.handle(IPC.lanesGetStackChain, async (_event, arg: { laneId: string }): Promise<StackChainItem[]> => {
    const ctx = ensureLaneContext();
    return await ctx.laneService.getStackChain(arg.laneId);
  });

  ipcMain.handle(IPC.lanesGetChildren, async (_event, arg: { laneId: string }): Promise<LaneSummary[]> => {
    const ctx = ensureLaneContext();
    return await ctx.laneService.getChildren(arg.laneId);
  });

  ipcMain.handle(IPC.lanesAttachLinearIssueToSession, async (
    _event,
    arg: { chatSessionId: string; issues: LaneLinearIssue[] },
  ): Promise<SessionLinearIssueLink[]> => {
    const ctx = ensureLaneContext();
    return ctx.laneService.attachLinearIssueToSession(arg);
  });

  ipcMain.handle(IPC.lanesDetachLinearIssueFromSession, async (
    _event,
    arg: { chatSessionId: string; issueId?: string },
  ): Promise<boolean> => {
    const ctx = ensureLaneContext();
    return ctx.laneService.detachLinearIssueFromSession(arg);
  });

  ipcMain.handle(IPC.lanesListLinearIssuesForSession, async (
    _event,
    arg: { chatSessionId: string },
  ): Promise<SessionLinearIssueLink[]> => {
    const ctx = ensureLaneContext();
    return ctx.laneService.listLinearIssuesForSession(arg);
  });

  ipcMain.handle(IPC.lanesListLinearIssuesForLaneSessions, async (
    _event,
    arg: { laneId: string },
  ): Promise<SessionLinearIssueLink[]> => {
    const ctx = ensureLaneContext();
    return ctx.laneService.listLinearIssuesForLaneSessions(arg);
  });

  ipcMain.handle(IPC.lanesUnlinkLinearIssues, async (
    _event,
    arg: { laneId: string; issueId?: string },
  ): Promise<boolean> => {
    const ctx = ensureLaneContext();
    return ctx.laneService.unlinkLinearIssues(arg);
  });

  ipcMain.handle(IPC.lanesRebaseStart, async (_event, arg: RebaseStartArgs): Promise<RebaseStartResult> => {
    const ctx = ensureLaneContext();
    return await ctx.laneService.rebaseStart(arg);
  });

  ipcMain.handle(IPC.lanesRebasePush, async (_event, arg: RebasePushArgs): Promise<RebaseRun> => {
    const ctx = ensureLaneContext();
    return await ctx.laneService.rebasePush(arg);
  });

  ipcMain.handle(IPC.lanesRebaseRollback, async (_event, arg: RebaseRollbackArgs): Promise<RebaseRun> => {
    const ctx = ensureLaneContext();
    return await ctx.laneService.rebaseRollback(arg);
  });

  ipcMain.handle(IPC.lanesRebaseAbort, async (_event, arg: RebaseAbortArgs): Promise<RebaseRun> => {
    const ctx = ensureLaneContext();
    return await ctx.laneService.rebaseAbort(arg);
  });

  ipcMain.handle(IPC.lanesListRebaseSuggestions, async (): Promise<RebaseSuggestion[]> => {
    const ctx = getCtx();
    if (!ctx.rebaseSuggestionService) return [];
    return await ctx.rebaseSuggestionService.listSuggestions();
  });

  ipcMain.handle(IPC.lanesDismissRebaseSuggestion, async (_event, arg: { laneId: string }): Promise<void> => {
    const ctx = getCtx();
    if (!ctx.rebaseSuggestionService) return;
    await ctx.rebaseSuggestionService.dismiss({ laneId: arg.laneId });
  });

  ipcMain.handle(IPC.lanesDeferRebaseSuggestion, async (_event, arg: { laneId: string; minutes: number }): Promise<void> => {
    const ctx = getCtx();
    if (!ctx.rebaseSuggestionService) return;
    await ctx.rebaseSuggestionService.defer({ laneId: arg.laneId, minutes: arg.minutes });
  });

  ipcMain.handle(IPC.lanesListAutoRebaseStatuses, async (): Promise<AutoRebaseLaneStatus[]> => {
    const ctx = getCtx();
    if (!ctx.autoRebaseService) return [];
    return await ctx.autoRebaseService.listStatuses();
  });

  ipcMain.handle(IPC.lanesDismissAutoRebaseStatus, async (_event, arg: { laneId: string }): Promise<void> => {
    const ctx = getCtx();
    if (!ctx.autoRebaseService) return;
    await ctx.autoRebaseService.dismissStatus({ laneId: arg.laneId });
  });

  ipcMain.handle(IPC.lanesOpenFolder, async (event, arg: { laneId: string }): Promise<void> => {
    const ctx = getCtx();
    let worktreePath: string | null = null;
    if (ctx.laneService) {
      worktreePath = ctx.laneService.getLaneWorktreePath(arg.laneId);
    } else {
      // Runtime-backed (daemon) mode: the in-process laneService is null, so
      // resolve the worktree path from the project's runtime via the pool.
      const response = await tryLocalRuntimeSync(event, (pool, rootPath) =>
        pool.callActionForRoot(rootPath, {
          domain: "lane",
          action: "list",
          args: { includeArchived: true, includeStatus: false },
        }),
      );
      const lanes = Array.isArray(response?.result) ? (response.result as LaneSummary[]) : [];
      worktreePath = lanes.find((lane) => lane.id === arg.laneId)?.worktreePath ?? null;
    }
    if (!worktreePath) {
      throw new Error("Lane worktree path is not available.");
    }
    await shell.openPath(worktreePath);
  });

  ipcMain.handle(IPC.lanesInitEnv, async (_event, args: { laneId: string }) => {
    const ctx = getCtx();
    if (!ctx.laneEnvironmentService) throw new Error("Lane environment service not available");
    const { lane, overrides, envInitConfig } = await resolveLaneOverlayContext(ctx, args.laneId);

    if (!envInitConfig) return { laneId: lane.id, steps: [], startedAt: new Date().toISOString(), completedAt: new Date().toISOString(), overallStatus: "completed" };
    return await ctx.laneEnvironmentService.initLaneEnvironment(lane, envInitConfig, overrides);
  });

  ipcMain.handle(IPC.lanesGetEnvStatus, async (_event, args: { laneId: string }) => {
    const ctx = getCtx();
    return ctx.laneEnvironmentService?.getProgress(args.laneId) ?? null;
  });

  ipcMain.handle(IPC.lanesGetOverlay, async (_event, args: { laneId: string }) => {
    const ctx = getCtx();
    const { overrides } = await resolveLaneOverlayContext(ctx, args.laneId);
    return overrides;
  });

  ipcMain.handle(IPC.lanesListTemplates, async () => {
    const ctx = getCtx();
    return ctx.laneTemplateService?.listTemplates() ?? [];
  });

  ipcMain.handle(IPC.lanesGetTemplate, async (_event, args: { templateId: string }) => {
    const ctx = getCtx();
    return ctx.laneTemplateService?.getTemplate(args.templateId) ?? null;
  });

  ipcMain.handle(IPC.lanesGetDefaultTemplate, async () => {
    const ctx = getCtx();
    return ctx.laneTemplateService?.getDefaultTemplateId() ?? null;
  });

  ipcMain.handle(IPC.lanesSetDefaultTemplate, async (_event, args: { templateId: string | null }) => {
    const ctx = getCtx();
    ctx.laneTemplateService?.setDefaultTemplateId(args.templateId);
  });

  ipcMain.handle(IPC.lanesApplyTemplate, async (_event, args: { laneId: string; templateId: string }) => {
    const ctx = getCtx();
    if (!ctx.laneTemplateService || !ctx.laneEnvironmentService) {
      throw new Error("Lane template or environment service not available");
    }
    const { lane, overrides, envInitConfig } = await resolveLaneOverlayContext(ctx, args.laneId);
    const template = ctx.laneTemplateService.getTemplate(args.templateId);
    if (!template) throw new Error(`Template not found: ${args.templateId}`);
    const templateEnvInit = ctx.laneTemplateService.resolveTemplateAsEnvInit(template);
    const mergedOverrides = mergeLaneOverrides(overrides, {
      ...(template.envVars ? { env: template.envVars } : {}),
      ...(!overrides.portRange && template.portRange ? { portRange: template.portRange } : {}),
      envInit: templateEnvInit
    });
    const mergedEnvInitConfig =
      mergeLaneEnvInitConfig(envInitConfig, templateEnvInit) ?? templateEnvInit;
    return await ctx.laneEnvironmentService.initLaneEnvironment(lane, mergedEnvInitConfig, mergedOverrides);
  });

  ipcMain.handle(IPC.lanesSaveTemplate, async (_event, args: { template: LaneTemplate }) => {
    const ctx = getCtx();
    if (!ctx.laneTemplateService) throw new Error("Lane template service not available");
    ctx.laneTemplateService.saveTemplate(args.template);
  });

  ipcMain.handle(IPC.lanesDeleteTemplate, async (_event, args: { templateId: string }) => {
    const ctx = getCtx();
    if (!ctx.laneTemplateService) throw new Error("Lane template service not available");
    ctx.laneTemplateService.deleteTemplate(args.templateId);
  });

  // --- Port Allocation (Phase 5 W3) ---

  ipcMain.handle(IPC.lanesPortGetLease, async (_event, args: { laneId: string }) => {
    const ctx = getCtx();
    await ensureLanePortLease(ctx, args.laneId);
    return ctx.portAllocationService?.getLease(args.laneId) ?? null;
  });

  ipcMain.handle(IPC.lanesPortListLeases, async () => {
    const ctx = getCtx();
    return ctx.portAllocationService?.listLeases() ?? [];
  });

  ipcMain.handle(IPC.lanesPortAcquire, async (_event, args: { laneId: string }) => {
    const ctx = getCtx();
    if (!ctx.portAllocationService) throw new Error("Port allocation service not available");
    return (await ensureLanePortLease(ctx, args.laneId))!;
  });

  ipcMain.handle(IPC.lanesPortRelease, async (_event, args: { laneId: string }) => {
    const ctx = ensureLaneContext();
    await ctx.laneService.list({ includeArchived: true, includeStatus: false }).then((lanes) => {
      if (!lanes.some((lane) => lane.id === args.laneId)) {
        throw new Error(`Lane not found: ${args.laneId}`);
      }
    });
    ctx.portAllocationService?.release(args.laneId);
  });

  ipcMain.handle(IPC.lanesPortListConflicts, async () => {
    const ctx = getCtx();
    return ctx.portAllocationService?.listConflicts() ?? [];
  });

  ipcMain.handle(IPC.lanesPortRecoverOrphans, async () => {
    const ctx = ensureLaneContext();
    if (!ctx.portAllocationService) return [];
    const lanes = await ctx.laneService.list({ includeArchived: false, includeStatus: false });
    const validIds = new Set(lanes.map((l) => l.id));
    return ctx.portAllocationService.recoverOrphans(validIds);
  });

  // --- Per-Lane Hostname Isolation & Preview (Phase 5 W4) --------------------

  const ensureLanePreviewInfo = async (laneId: string) => {
    const ctx = ensureLaneContext();
    if (!ctx.laneProxyService || !ctx.portAllocationService) return null;

    const lane = (await ctx.laneService.list({ includeArchived: false, includeStatus: false })).find(
      (item) => item.id === laneId
    );
    if (!lane) {
      ctx.laneProxyService.removeRoute(laneId);
      return null;
    }

    const lease = ctx.portAllocationService.getLease(laneId);
    if (!lease || lease.status !== "active") {
      ctx.laneProxyService.removeRoute(laneId);
      return null;
    }

    if (!ctx.laneProxyService.getStatus().running) {
      try {
        await ctx.laneProxyService.start();
      } catch (error) {
        ctx.logger.warn("lane_proxy.preview_start_failed", {
          laneId,
          error: error instanceof Error ? error.message : String(error),
        });
        return null;
      }
    }

    const expectedHostname = ctx.laneProxyService.generateHostname(laneId, lane.name);
    const health = ctx.runtimeDiagnosticsService
      ? await ctx.runtimeDiagnosticsService.checkLaneHealth(laneId).catch(() => null)
      : null;
    const validatedRespondingPort =
      Number.isInteger(health?.respondingPort) &&
      (health?.respondingPort as number) > 0 &&
      (health?.respondingPort as number) >= lease.rangeStart &&
      (health?.respondingPort as number) <= lease.rangeEnd
        ? (health?.respondingPort as number)
        : null;
    const targetPort = validatedRespondingPort ?? lease.rangeStart;
    const currentRoute = ctx.laneProxyService.getRoute(laneId);
    if (
      !currentRoute ||
      currentRoute.targetPort !== targetPort ||
      currentRoute.hostname !== expectedHostname ||
      currentRoute.status !== "active"
    ) {
      ctx.laneProxyService.addRoute(laneId, targetPort, lane.name);
    }

    return ctx.laneProxyService.getPreviewInfo(laneId);
  };

  ipcMain.handle(IPC.lanesProxyGetStatus, async () => {
    const ctx = getCtx();
    return ctx.laneProxyService?.getStatus() ?? { running: false, proxyPort: 8080, routes: [] };
  });

  ipcMain.handle(IPC.lanesProxyStart, async (_event, args?: { port?: number }) => {
    const ctx = getCtx();
    if (!ctx.laneProxyService) throw new Error("Proxy service not available");
    return ctx.laneProxyService.start(args?.port);
  });

  ipcMain.handle(IPC.lanesProxyStop, async () => {
    const ctx = getCtx();
    if (!ctx.laneProxyService) return;
    await ctx.laneProxyService.stop();
  });

  ipcMain.handle(IPC.lanesProxyAddRoute, async (_event, args: { laneId: string; targetPort: number }) => {
    const ctx = ensureLaneContext();
    if (!ctx.laneProxyService) throw new Error("Proxy service not available");
    const lane = (await ctx.laneService.list({ includeArchived: false, includeStatus: false })).find((l) => l.id === args.laneId);
    return ctx.laneProxyService.addRoute(args.laneId, args.targetPort, lane?.name);
  });

  ipcMain.handle(IPC.lanesProxyRemoveRoute, async (_event, args: { laneId: string }) => {
    const ctx = getCtx();
    ctx.laneProxyService?.removeRoute(args.laneId);
  });

  ipcMain.handle(IPC.lanesProxyGetPreviewInfo, async (_event, args: { laneId: string }) => {
    return ensureLanePreviewInfo(args.laneId);
  });

  ipcMain.handle(IPC.lanesProxyOpenPreview, async (_event, args: { laneId: string }) => {
    const info = await ensureLanePreviewInfo(args.laneId);
    if (!info) throw new Error(`No preview route for lane: ${args.laneId}`);
    const { shell } = await import("electron");
    await shell.openExternal(info.previewUrl);
  });

  // --- OAuth Redirect Handling (Phase 5 W5) ---

  const requireRecord = (value: unknown, name: string): Record<string, unknown> => {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
    throw new Error(`${name} must be an object`);
  };

  const parseOAuthUpdateConfigArgs = (
    value: unknown,
  ): UpdateOAuthRedirectConfigArgs => {
    const record = requireRecord(value, "OAuth config update");
    const updates: UpdateOAuthRedirectConfigArgs = {};

    if ("enabled" in record) {
      if (typeof record.enabled !== "boolean") {
        throw new Error("OAuth config enabled must be boolean");
      }
      updates.enabled = record.enabled;
    }

    if ("routingMode" in record) {
      if (
        record.routingMode !== "state-parameter" &&
        record.routingMode !== "hostname"
      ) {
        throw new Error("OAuth routing mode is invalid");
      }
      updates.routingMode = record.routingMode;
    }

    if ("callbackPaths" in record) {
      if (
        !Array.isArray(record.callbackPaths) ||
        record.callbackPaths.some((path) => typeof path !== "string")
      ) {
        throw new Error("OAuth callback paths must be an array of strings");
      }
      updates.callbackPaths = [...record.callbackPaths];
    }

    return updates;
  };

  const parseGenerateRedirectUrisArgs = (
    value: unknown,
  ): GenerateRedirectUrisArgs => {
    if (value === undefined) return {};
    const record = requireRecord(value, "OAuth redirect URI request");
    if (record.provider === undefined) return {};
    if (typeof record.provider !== "string") {
      throw new Error("OAuth provider must be a string");
    }
    return { provider: record.provider };
  };

  const parseEncodeOAuthStateArgs = (
    value: unknown,
  ): EncodeOAuthStateArgs => {
    const record = requireRecord(value, "OAuth state encode request");
    if (typeof record.laneId !== "string" || !record.laneId.trim()) {
      throw new Error("OAuth state encode laneId must be a non-empty string");
    }
    if (typeof record.originalState !== "string") {
      throw new Error("OAuth state encode originalState must be a string");
    }
    return { laneId: record.laneId, originalState: record.originalState };
  };

  const parseDecodeOAuthStateArgs = (
    value: unknown,
  ): DecodeOAuthStateArgs => {
    const record = requireRecord(value, "OAuth state decode request");
    if (typeof record.encodedState !== "string" || !record.encodedState) {
      throw new Error("OAuth state decode encodedState must be a non-empty string");
    }
    return { encodedState: record.encodedState };
  };

  const parseDiagnosticsLaneIdArgs = (
    value: unknown,
  ): { laneId: string } => {
    const record = requireRecord(value, "Runtime diagnostics request");
    if (typeof record.laneId !== "string" || !record.laneId.trim()) {
      throw new Error("Runtime diagnostics laneId must be a non-empty string");
    }
    return { laneId: record.laneId };
  };

  const parseAgentChatCancelSteerArgs = (
    value: unknown,
  ): AgentChatCancelSteerArgs => {
    const record = requireRecord(value, "Agent chat cancel steer request");
    if (typeof record.sessionId !== "string" || !record.sessionId.trim()) {
      throw new Error("Agent chat cancel steer sessionId must be a non-empty string");
    }
    if (typeof record.steerId !== "string" || !record.steerId.trim()) {
      throw new Error("Agent chat cancel steer steerId must be a non-empty string");
    }
    if (record.requireQueued !== undefined && typeof record.requireQueued !== "boolean") {
      throw new Error("Agent chat cancel steer requireQueued must be a boolean");
    }
    return {
      sessionId: record.sessionId.trim(),
      steerId: record.steerId.trim(),
      ...(record.requireQueued === true ? { requireQueued: true } : {}),
    };
  };

  const parseAgentChatEditSteerArgs = (
    value: unknown,
  ): AgentChatEditSteerArgs => {
    const record = requireRecord(value, "Agent chat edit steer request");
    if (typeof record.sessionId !== "string" || !record.sessionId.trim()) {
      throw new Error("Agent chat edit steer sessionId must be a non-empty string");
    }
    if (typeof record.steerId !== "string" || !record.steerId.trim()) {
      throw new Error("Agent chat edit steer steerId must be a non-empty string");
    }
    if (typeof record.text !== "string") {
      throw new Error("Agent chat edit steer text must be a string");
    }
    return { sessionId: record.sessionId.trim(), steerId: record.steerId.trim(), text: record.text };
  };

  const parseAgentChatDispatchSteerArgs = (
    value: unknown,
  ): AgentChatDispatchSteerArgs => {
    const record = requireRecord(value, "Agent chat dispatch steer request");
    if (typeof record.sessionId !== "string" || !record.sessionId.trim()) {
      throw new Error("Agent chat dispatch steer sessionId must be a non-empty string");
    }
    if (typeof record.steerId !== "string" || !record.steerId.trim()) {
      throw new Error("Agent chat dispatch steer steerId must be a non-empty string");
    }
    if (record.mode !== "inline" && record.mode !== "interrupt") {
      throw new Error("Agent chat dispatch steer mode must be 'inline' or 'interrupt'");
    }
    return {
      sessionId: record.sessionId.trim(),
      steerId: record.steerId.trim(),
      mode: record.mode,
    };
  };

  const parseAgentChatCancelDispatchedSteerArgs = (
    value: unknown,
  ): AgentChatCancelDispatchedSteerArgs => {
    const record = requireRecord(value, "Agent chat cancel dispatched steer request");
    if (typeof record.sessionId !== "string" || !record.sessionId.trim()) {
      throw new Error("Agent chat cancel dispatched steer sessionId must be a non-empty string");
    }
    if (typeof record.steerId !== "string" || !record.steerId.trim()) {
      throw new Error("Agent chat cancel dispatched steer steerId must be a non-empty string");
    }
    return { sessionId: record.sessionId.trim(), steerId: record.steerId.trim() };
  };

  const parseAgentChatSuggestLaneNameArgs = (value: unknown): AgentChatSuggestLaneNameArgs => {
    const record = requireRecord(value, "Agent chat suggest lane name request");
    if (typeof record.prompt !== "string" || !record.prompt.trim()) {
      throw new Error("Agent chat suggest lane name prompt must be a non-empty string");
    }
    if (typeof record.modelId !== "string" || !record.modelId.trim()) {
      throw new Error("Agent chat suggest lane name model ID must be a non-empty string");
    }
    if (typeof record.laneId !== "string" || !record.laneId.trim()) {
      throw new Error("Agent chat suggest lane name lane ID must be a non-empty string");
    }
    return {
      prompt: record.prompt.trim(),
      modelId: record.modelId.trim(),
      laneId: record.laneId.trim(),
      ...(typeof record.fallbackName === "string" && record.fallbackName.trim().length
        ? { fallbackName: record.fallbackName.trim() }
        : {}),
    };
  };

  const parseAgentChatParallelLaunchStateArgs = (value: unknown): AgentChatParallelLaunchStateArgs => {
    const record = requireRecord(value, "Agent chat parallel launch state request");
    if (typeof record.projectRoot !== "string" || !record.projectRoot.trim()) {
      throw new Error("Agent chat parallel launch state project root must be a non-empty string");
    }
    if (typeof record.parentLaneId !== "string" || !record.parentLaneId.trim()) {
      throw new Error("Agent chat parallel launch state parent lane ID must be a non-empty string");
    }
    return {
      projectRoot: record.projectRoot.trim(),
      parentLaneId: record.parentLaneId.trim(),
    };
  };

  const sanitizeParallelLaunchLaneIds = (value: unknown): string[] => {
    if (!Array.isArray(value)) return [];
    return Array.from(new Set(
      value
        .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
        .filter(Boolean),
    ));
  };

  const normalizeAgentChatParallelLaunchState = (
    value: unknown,
    parentLaneIdFallback: string,
  ): AgentChatParallelLaunchState | null => {
    if (!value || typeof value !== "object") return null;
    const parsed = value as {
      parentLaneId?: unknown;
      createdLaneIds?: unknown;
      sentLaneIds?: unknown;
      status?: unknown;
      updatedAt?: unknown;
      lastError?: unknown;
    };
    const parentLaneId = typeof parsed.parentLaneId === "string" && parsed.parentLaneId.trim().length
      ? parsed.parentLaneId.trim()
      : parentLaneIdFallback;
    const createdLaneIds = sanitizeParallelLaunchLaneIds(parsed.createdLaneIds);
    if (createdLaneIds.length === 0) return null;
    const sentLaneIds = sanitizeParallelLaunchLaneIds(parsed.sentLaneIds)
      .filter((laneId) => createdLaneIds.includes(laneId));
    const status = parsed.status === "creating_lanes"
      || parsed.status === "sending"
      || parsed.status === "completed"
      || parsed.status === "cleanup_pending"
      ? parsed.status
      : sentLaneIds.length >= createdLaneIds.length
        ? "completed"
        : "creating_lanes";
    return {
      parentLaneId,
      createdLaneIds,
      sentLaneIds,
      status,
      updatedAt: typeof parsed.updatedAt === "string" && parsed.updatedAt.trim().length
        ? parsed.updatedAt.trim()
        : new Date(0).toISOString(),
      lastError: typeof parsed.lastError === "string" && parsed.lastError.trim().length
        ? parsed.lastError.trim()
        : null,
    };
  };

  const agentChatParallelLaunchStateKey = (projectRoot: string, parentLaneId: string): string =>
    `agent-chat-parallel-launch:${projectRoot}:${parentLaneId}`;

  ipcMain.handle(IPC.lanesOAuthGetStatus, async () => {
    const ctx = getCtx();
    return ctx.oauthRedirectService?.getStatus() ?? {
      enabled: false,
      routingMode: "state-parameter" as const,
      activeSessions: [],
      callbackPaths: [],
    };
  });

  ipcMain.handle(IPC.lanesOAuthUpdateConfig, async (_event, args: unknown) => {
    const ctx = getCtx();
    if (!ctx.oauthRedirectService) throw new Error("OAuth redirect service not available");
    ctx.oauthRedirectService.updateConfig(parseOAuthUpdateConfigArgs(args));
  });

  ipcMain.handle(IPC.lanesOAuthGenerateRedirectUris, async (_event, args: unknown) => {
    const ctx = getCtx();
    if (!ctx.oauthRedirectService) return [];
    const request = parseGenerateRedirectUrisArgs(args);
    return ctx.oauthRedirectService.generateRedirectUris(request.provider);
  });

  ipcMain.handle(IPC.lanesOAuthEncodeState, async (_event, args: unknown) => {
    const ctx = getCtx();
    if (!ctx.oauthRedirectService) throw new Error("OAuth redirect service not available");
    const request = parseEncodeOAuthStateArgs(args);
    return ctx.oauthRedirectService.encodeState(
      request.laneId,
      request.originalState,
    );
  });

  ipcMain.handle(IPC.lanesOAuthDecodeState, async (_event, args: unknown) => {
    const ctx = getCtx();
    if (!ctx.oauthRedirectService) return null;
    const request = parseDecodeOAuthStateArgs(args);
    return ctx.oauthRedirectService.decodeState(request.encodedState);
  });

  ipcMain.handle(IPC.lanesOAuthListSessions, async () => {
    const ctx = getCtx();
    return ctx.oauthRedirectService?.listSessions() ?? [];
  });

  // --- Runtime Diagnostics (Phase 5 W6) ---

  ipcMain.handle(IPC.lanesDiagnosticsGetStatus, async () => {
    const ctx = getCtx();
    if (!ctx.runtimeDiagnosticsService) {
      const proxyStatus = ctx.laneProxyService?.getStatus();
      return {
        lanes: [],
        proxyRunning: proxyStatus?.running ?? false,
        proxyPort: proxyStatus?.proxyPort ?? 0,
        totalRoutes: proxyStatus?.routes.length ?? 0,
        activeConflicts: 0,
        fallbackLanes: [],
      };
    }
    requireAppContextServices(ctx, ["laneService"] as const);
    const lanes = await ctx.laneService.list({ includeArchived: false, includeStatus: false });
    return ctx.runtimeDiagnosticsService.getStatus(lanes.map((l) => l.id));
  });

  ipcMain.handle(IPC.lanesDiagnosticsGetLaneHealth, async (_event, args: unknown) => {
    const ctx = getCtx();
    const request = parseDiagnosticsLaneIdArgs(args);
    return ctx.runtimeDiagnosticsService?.getLaneHealth(request.laneId) ?? null;
  });

  ipcMain.handle(IPC.lanesDiagnosticsRunHealthCheck, async (_event, args: unknown) => {
    const ctx = getCtx();
    if (!ctx.runtimeDiagnosticsService) throw new Error("Diagnostics service not available");
    const request = parseDiagnosticsLaneIdArgs(args);
    return ctx.runtimeDiagnosticsService.checkLaneHealth(request.laneId);
  });

  ipcMain.handle(IPC.lanesDiagnosticsRunFullCheck, async () => {
    const ctx = getCtx();
    if (!ctx.runtimeDiagnosticsService) return [];
    requireAppContextServices(ctx, ["laneService"] as const);
    const lanes = await ctx.laneService.list({ includeArchived: false, includeStatus: false });
    return ctx.runtimeDiagnosticsService.checkAllLanes(lanes.map((l) => l.id));
  });

  ipcMain.handle(IPC.lanesDiagnosticsActivateFallback, async (_event, args: unknown) => {
    const ctx = getCtx();
    if (!ctx.runtimeDiagnosticsService) throw new Error("Diagnostics service not available");
    const request = parseDiagnosticsLaneIdArgs(args);
    ctx.runtimeDiagnosticsService.activateFallback(request.laneId);
  });

  ipcMain.handle(IPC.lanesDiagnosticsDeactivateFallback, async (_event, args: unknown) => {
    const ctx = getCtx();
    if (!ctx.runtimeDiagnosticsService) throw new Error("Diagnostics service not available");
    const request = parseDiagnosticsLaneIdArgs(args);
    ctx.runtimeDiagnosticsService.deactivateFallback(request.laneId);
  });

  const ensureSessionContext = (): AppContextWith<"sessionService"> => {
    const ctx = getCtx();
    requireAppContextServices(ctx, ["sessionService"] as const);
    return ctx;
  };

  const ensureAgentChatContext = (): AppContextWith<"agentChatService"> => {
    const ctx = getCtx();
    requireAppContextServices(ctx, ["agentChatService"] as const);
    return ctx;
  };

  const ensureAgentChatFileContext = (): AppContextWith<"agentChatService" | "fileService"> => {
    const ctx = getCtx();
    requireAppContextServices(ctx, ["agentChatService", "fileService"] as const);
    return ctx;
  };

  ipcMain.handle(IPC.sessionsList, async (_event, arg: ListSessionsArgs): Promise<TerminalSessionSummary[]> => {
    const ctx = ensureSessionContext();
    const ptyService = requirePtyService();
    return await withIpcTiming(
      ctx,
      "sessions.list",
      async () => {
        let listedSessions = ctx.sessionService.list(arg);
        const missingResumeTargetIds = listedSessions
          .filter(sessionNeedsResumeTargetHydration)
          .slice(0, 10)
          .map((session) => session.id);
        if (missingResumeTargetIds.length > 0) {
          try {
            await ptyService.ensureResumeTargets(missingResumeTargetIds);
            listedSessions = ctx.sessionService.list(arg);
          } catch (err) {
            ctx.logger.warn("sessions.resume_target_hydration_failed", {
              sessionIds: missingResumeTargetIds,
              err: String(err),
            });
          }
        }
        let sessions = ptyService.enrichSessions(listedSessions);
        const laneId = typeof arg?.laneId === "string" ? arg.laneId.trim() : "";
        let allChats: AgentChatSessionSummary[] = [];
        try {
          allChats = await ctx.agentChatService?.listSessions(laneId || undefined, { includeIdentity: true }) ?? [];
        } catch {
          allChats = [];
        }
        const identitySessionIds = new Set(
          allChats
            .filter((chat) => Boolean(chat.identityKey))
            .map((chat) => chat.sessionId),
        );
        if (identitySessionIds.size > 0) {
          sessions = sessions.filter((session) => !identitySessionIds.has(session.id));
        }
        const chats = allChats.filter((chat) => !chat.identityKey);
        if (chats.length === 0) return sessions;
        const chatSummaryBySessionId = new Map(chats.map((chat) => [chat.sessionId, chat] as const));
        return sessions.map((session) => {
          if (!isChatToolType(session.toolType)) return session;
          const chat = chatSummaryBySessionId.get(session.id);
          if (!chat) return session;
          return projectChatOntoSession(session, chat);
        });
      },
      {
        laneId: typeof arg?.laneId === "string" ? arg.laneId : null,
        limit: typeof arg?.limit === "number" ? arg.limit : null
      }
    );
  });

  ipcMain.handle(IPC.sessionsGet, async (_event, arg: { sessionId: string }): Promise<TerminalSessionDetail | null> => {
    const ctx = ensureSessionContext();
    const ptyService = requirePtyService();
    let session = ctx.sessionService.get(arg.sessionId);
    if (!session) return null;
    if (sessionNeedsResumeTargetHydration(session)) {
      const sessionId = session.id;
      try {
        await ptyService.ensureResumeTargets([sessionId]);
        const hydratedSession = ctx.sessionService.get(arg.sessionId);
        if (hydratedSession) session = hydratedSession;
      } catch (err) {
        ctx.logger.warn("sessions.resume_target_hydration_failed", {
          sessionIds: [sessionId],
          err: String(err),
        });
      }
    }
    let enriched = ptyService.enrichSessions([session])[0] ?? {
      ...session,
      runtimeState: ptyService.getRuntimeState(session.id, session.status)
    };
    if (enriched.status === "running" && isChatToolType(enriched.toolType)) {
      try {
        const chat = await ctx.agentChatService?.getSessionSummary(enriched.id);
        if (chat) enriched = projectChatOntoSession(enriched, chat);
      } catch {
        // Detail reads should still return the persisted session if chat state
        // hydration fails during runtime restart/recovery.
      }
    }
    return enriched;
  });

  ipcMain.handle(IPC.sessionsDelete, async (_event, arg: DeleteSessionArgs): Promise<void> => {
    const ctx = ensureSessionContext();
    const sessionId = typeof arg?.sessionId === "string" ? arg.sessionId.trim() : "";
    if (!sessionId) {
      throw new Error("Session id is required.");
    }
    deleteTerminalSessionWithRuntimeCleanup({
      sessionId,
      sessionService: ctx.sessionService,
      ptyService: requirePtyService(),
    });
  });

  ipcMain.handle(IPC.sessionsUpdateMeta, async (_event, arg: UpdateSessionMetaArgs): Promise<TerminalSessionSummary | null> => {
    const ctx = ensureSessionContext();
    return ctx.sessionService.updateMeta(arg);
  });

  ipcMain.handle(IPC.sessionsReadTranscriptTail, async (_event, arg: { sessionId: string; maxBytes?: number; raw?: boolean }): Promise<string> => {
    const ctx = ensureSessionContext();
    const session = ctx.sessionService.get(arg.sessionId);
    if (!session) return "";
    const maxBytes = typeof arg.maxBytes === "number" ? Math.max(1024, Math.min(16_000_000, arg.maxBytes)) : 160_000;
    const raw = arg.raw === true;
    return requirePtyService().readTranscriptTail({
      sessionId: session.id,
      maxBytes,
      raw,
      alignToLineBoundary: raw,
    });
  });

  ipcMain.handle(IPC.sessionsGetDelta, async (_event, arg: { sessionId: string }): Promise<SessionDeltaSummary | null> => {
    const ctx = getCtx();
    return ctx.sessionDeltaService?.getSessionDelta(arg.sessionId) ?? null;
  });

  // ── Voice-to-text dictation ──────────────────────────────────────────────
  // The transcription service is project-independent (no DB / lane deps): it
  // only needs the bundled whisper binary + model + the shared glossary. It is
  // resolved from the active context, where it is threaded as a shared
  // singleton (see main.ts).
  type TranscriptionPcmFormat = "int16" | "float32";
  const DEFAULT_TRANSCRIPTION_SAMPLE_RATE = 16_000;
  const MIN_TRANSCRIPTION_SAMPLE_RATE = 8_000;
  const MAX_TRANSCRIPTION_SAMPLE_RATE = 48_000;
  const MAX_TRANSCRIPTION_SECONDS = 5 * 60;

  const normalizeTranscriptionFormat = (format: unknown): TranscriptionPcmFormat => {
    if (format == null) return "int16";
    if (format === "int16" || format === "float32") return format;
    throw new Error("transcribe_failed: Unsupported audio format.");
  };

  const normalizeTranscriptionSampleRate = (sampleRate: unknown): number => {
    if (sampleRate == null) return DEFAULT_TRANSCRIPTION_SAMPLE_RATE;
    if (
      typeof sampleRate !== "number"
      || !Number.isFinite(sampleRate)
      || sampleRate < MIN_TRANSCRIPTION_SAMPLE_RATE
      || sampleRate > MAX_TRANSCRIPTION_SAMPLE_RATE
    ) {
      throw new Error(
        `transcribe_failed: Invalid audio sample rate; expected ${MIN_TRANSCRIPTION_SAMPLE_RATE}-${MAX_TRANSCRIPTION_SAMPLE_RATE} Hz.`,
      );
    }
    return Math.round(sampleRate);
  };

  const normalizeTranscriptionBuffer = (
    pcmValue: unknown,
    format: TranscriptionPcmFormat,
    sampleRate: number,
  ): ArrayBuffer => {
    let buffer: ArrayBuffer | null = null;
    if (pcmValue instanceof ArrayBuffer) {
      buffer = pcmValue;
    } else if (pcmValue instanceof Int16Array && format === "int16") {
      buffer = new ArrayBuffer(pcmValue.byteLength);
      new Uint8Array(buffer).set(new Uint8Array(pcmValue.buffer, pcmValue.byteOffset, pcmValue.byteLength));
    }
    if (!buffer || buffer.byteLength === 0) {
      throw new Error("empty_audio: No audio was captured.");
    }

    const bytesPerSample = format === "float32" ? 4 : 2;
    if (buffer.byteLength % bytesPerSample !== 0) {
      throw new Error("transcribe_failed: Invalid audio buffer alignment.");
    }

    const sampleCount = buffer.byteLength / bytesPerSample;
    if (sampleCount / sampleRate > MAX_TRANSCRIPTION_SECONDS) {
      throw new Error(`transcribe_failed: Dictation is limited to ${Math.round(MAX_TRANSCRIPTION_SECONDS / 60)} minutes.`);
    }

    return buffer;
  };

  ipcMain.handle(
    IPC.transcriptionTranscribe,
    async (
      _event,
      arg: { pcm: ArrayBuffer | Int16Array; sampleRate?: number; format?: "int16" | "float32" },
    ): Promise<TranscriptionResult> => {
      const service = getCtx().transcriptionService;
      if (!service) {
        throw new Error("model_not_installed: Voice model not installed");
      }
      // PCM arrives as a transferable ArrayBuffer (or a typed array when called
      // in-process from tests). Validate before constructing a typed view so a
      // malformed renderer-controlled payload cannot reach WAV encoding.
      const format = normalizeTranscriptionFormat(arg?.format);
      const sampleRate = normalizeTranscriptionSampleRate(arg?.sampleRate);
      const buffer = normalizeTranscriptionBuffer(arg?.pcm, format, sampleRate);
      const pcm = format === "float32"
        ? new Float32Array(buffer)
        : new Int16Array(buffer);
      try {
        return await service.transcribe(pcm, { sampleRate });
      } catch (error) {
        if (error instanceof TranscriptionError) {
          // Surface the typed code via the message prefix the renderer matches on.
          throw new Error(`${error.code}: ${error.message}`);
        }
        throw error;
      }
    },
  );

  ipcMain.handle(IPC.transcriptionStatus, async (): Promise<TranscriptionStatus> => {
    const service = getCtx().transcriptionService;
    if (!service) {
      return {
        installed: false,
        binaryInstalled: false,
        modelInstalled: false,
        downloading: false,
        binaryPath: null,
        modelPath: null,
      };
    }
    return service.getStatus();
  });

  // Download the ~141 MB speech model on demand (first dictation). Streams to
  // disk in the main process; progress is pushed to the requesting renderer.
  ipcMain.handle(
    IPC.transcriptionDownloadModel,
    async (event): Promise<TranscriptionStatus> => {
      const service = getCtx().transcriptionService;
      if (!service) {
        throw new Error("model_not_installed: Voice model not installed");
      }
      let lastEmit = 0;
      await service.downloadModel((progress) => {
        // Throttle progress pushes to ~10/s so we don't flood IPC for a 141 MB file.
        const nowMs = Date.now();
        if (nowMs - lastEmit < 100 && progress.receivedBytes < (progress.totalBytes ?? Infinity)) {
          return;
        }
        lastEmit = nowMs;
        if (!event.sender.isDestroyed()) {
          event.sender.send(IPC.transcriptionModelDownloadProgress, progress);
        }
      });
      return service.getStatus();
    },
  );

  // Ensure macOS microphone access before the renderer calls getUserMedia.
  // Electron on macOS returns a silent (all-zero) audio track instead of
  // throwing when the OS hasn't granted mic access, so we must check/request
  // the system-level permission explicitly (electron/electron#23792, #42714).
  ipcMain.handle(
    IPC.transcriptionRequestMicAccess,
    async (): Promise<{ status: "granted" | "denied" | "not-determined" | "restricted" | "unknown" }> => {
      if (process.platform !== "darwin") {
        return { status: "granted" };
      }
      const current = systemPreferences.getMediaAccessStatus("microphone");
      if (current === "granted") {
        return { status: "granted" };
      }
      if (current === "not-determined") {
        try {
          const ok = await systemPreferences.askForMediaAccess("microphone");
          return { status: ok ? "granted" : "denied" };
        } catch {
          return { status: "denied" };
        }
      }
      // "denied" | "restricted" | "unknown" — the user must change this in
      // System Settings; askForMediaAccess will not re-prompt.
      return { status: current };
    },
  );

  ipcMain.handle(IPC.agentChatList, async (_event, arg: AgentChatListArgs = {}): Promise<AgentChatSessionSummary[]> => {
    const ctx = getCtx();
    const service = ctx.agentChatService;
    if (!service || typeof (service as unknown as { listSessions?: unknown }).listSessions !== "function") {
      return [];
    }
    const laneId = typeof arg?.laneId === "string" ? arg.laneId.trim() : "";
    return await (service as unknown as {
      listSessions: (
        laneId?: string,
        options?: { includeAutomation?: boolean },
      ) => Promise<AgentChatSessionSummary[]>;
    }).listSessions(laneId || undefined, { includeAutomation: Boolean(arg?.includeAutomation) });
  });

  ipcMain.handle(IPC.agentChatGetSummary, async (_event, arg: AgentChatGetSummaryArgs): Promise<AgentChatSessionSummary | null> => {
    const ctx = ensureAgentChatContext();
    return await ctx.agentChatService.getSessionSummary(arg?.sessionId ?? "");
  });

  ipcMain.handle(IPC.agentChatCreate, async (_event, arg: AgentChatCreateArgs): Promise<AgentChatSession> => {
    const ctx = ensureAgentChatContext();
    return await ctx.agentChatService.createSession(arg);
  });

  ipcMain.handle(IPC.agentChatLaunch, async (_event, arg: AgentChatLaunchArgs): Promise<AgentChatSession> => {
    const ctx = ensureAgentChatContext();
    return await ctx.agentChatService.launchHeadless(arg);
  });

  // Launch a tracked CLI/terminal agent with Linear issues attached *before* the
  // process spawns. The new terminal's own session id doubles as the Linear
  // link key, so `getSessionLinearEnv` injects ADE_LINEAR_ISSUE_IDS +
  // ADE_LINEAR_CONTEXT_FILE into the PTY env (the agent reads/updates its issue
  // via `ade linear`, no token needed). The kickoff prompt is built into the
  // provider's startup command / initialInput.
  ipcMain.handle(IPC.agentChatLaunchCli, async (_event, arg: AgentChatLaunchCliArgs): Promise<AgentChatLaunchCliResult> => {
    const ctx = getCtx();
    if (!ctx.laneService) {
      throw new Error("agentChat.launchCli requires an active project runtime lane service.");
    }
    if (!ctx.ptyService) {
      throw new Error("agentChat.launchCli requires an active terminal (pty) service.");
    }
    return launchAgentChatCli(arg, {
      laneService: ctx.laneService,
      ptyService: ctx.ptyService,
      logger: ctx.logger,
    });
  });

  ipcMain.handle(IPC.agentChatSuggestLaneName, async (_event, arg: unknown): Promise<string> => {
    const ctx = ensureAgentChatContext();
    return await ctx.agentChatService.suggestLaneNameFromPrompt(parseAgentChatSuggestLaneNameArgs(arg));
  });

  ipcMain.handle(IPC.agentChatParallelLaunchStateGet, async (_event, arg: unknown): Promise<AgentChatParallelLaunchState | null> => {
    const ctx = ensureDbContext();
    const { projectRoot, parentLaneId } = parseAgentChatParallelLaunchStateArgs(arg);
    const key = agentChatParallelLaunchStateKey(projectRoot, parentLaneId);
    return normalizeAgentChatParallelLaunchState(
      ctx.db.getJson<AgentChatParallelLaunchState | null>(key),
      parentLaneId,
    );
  });

  ipcMain.handle(IPC.agentChatParallelLaunchStateSet, async (_event, arg: AgentChatSetParallelLaunchStateArgs): Promise<void> => {
    const ctx = ensureDbContext();
    const { projectRoot, parentLaneId } = parseAgentChatParallelLaunchStateArgs(arg);
    const key = agentChatParallelLaunchStateKey(projectRoot, parentLaneId);
    const nextState = normalizeAgentChatParallelLaunchState(arg?.state ?? null, parentLaneId);
    ctx.db.setJson(key, nextState);
  });

  ipcMain.handle(IPC.agentChatHandoff, async (_event, arg: AgentChatHandoffArgs): Promise<AgentChatHandoffResult> => {
    const ctx = ensureAgentChatContext();
    return await ctx.agentChatService.handoffSession(arg);
  });

  ipcMain.handle(
    IPC.agentChatPrepareCrossMachineHandoff,
    async (_event, arg: AgentChatPrepareCrossMachineHandoffArgs): Promise<AgentChatPrepareCrossMachineHandoffResult> => {
      const ctx = ensureAgentChatContext();
      return await ctx.agentChatService.prepareCrossMachineHandoff(arg);
    },
  );

  ipcMain.handle(
    IPC.agentChatValidateCrossMachineSource,
    async (_event, arg: AgentChatValidateCrossMachineSourceArgs): Promise<void> => {
      const ctx = ensureAgentChatContext();
      await ctx.agentChatService.validateCrossMachineSource(arg);
    },
  );

  ipcMain.handle(
    IPC.agentChatMarkCrossMachineHandoff,
    async (_event, arg: AgentChatMarkCrossMachineHandoffArgs): Promise<void> => {
      const ctx = ensureAgentChatContext();
      await ctx.agentChatService.markCrossMachineHandoff(arg);
    },
  );

  ipcMain.handle(IPC.agentChatSend, async (_event, arg: AgentChatSendArgs): Promise<void> => {
    const ctx = ensureAgentChatContext();
    await ctx.agentChatService.sendMessage(arg, { awaitDispatch: true });
  });

  ipcMain.handle(IPC.agentChatSteer, async (_event, arg: AgentChatSteerArgs): Promise<AgentChatSteerResult> => {
    const ctx = ensureAgentChatContext();
    return await ctx.agentChatService.steer(arg);
  });

  ipcMain.handle(IPC.agentChatCancelSteer, async (_event, arg: unknown): Promise<void> => {
    const ctx = ensureAgentChatContext();
    await ctx.agentChatService.cancelSteer(parseAgentChatCancelSteerArgs(arg));
  });

  ipcMain.handle(IPC.agentChatEditSteer, async (_event, arg: unknown): Promise<void> => {
    const ctx = ensureAgentChatContext();
    await ctx.agentChatService.editSteer(parseAgentChatEditSteerArgs(arg));
  });

  ipcMain.handle(IPC.agentChatDispatchSteer, async (_event, arg: unknown): Promise<AgentChatDispatchSteerResult> => {
    const ctx = ensureAgentChatContext();
    return await ctx.agentChatService.dispatchSteer(parseAgentChatDispatchSteerArgs(arg));
  });

  ipcMain.handle(IPC.agentChatCancelDispatchedSteer, async (_event, arg: unknown): Promise<AgentChatCancelDispatchedSteerResult> => {
    const ctx = ensureAgentChatContext();
    return await ctx.agentChatService.cancelDispatchedSteer(parseAgentChatCancelDispatchedSteerArgs(arg));
  });

  ipcMain.handle(IPC.agentChatInterrupt, async (_event, arg: AgentChatInterruptArgs): Promise<void> => {
    const ctx = ensureAgentChatContext();
    await ctx.agentChatService.interrupt(arg);
  });

  ipcMain.handle(IPC.agentChatRecoverCodexTurn, async (
    _event,
    arg: AgentChatRecoverCodexTurnArgs,
  ): Promise<AgentChatRecoverCodexTurnResult> => {
    const ctx = ensureAgentChatContext();
    return await ctx.agentChatService.recoverCodexTurn(arg);
  });

  ipcMain.handle(IPC.agentChatApprove, async (_event, arg: AgentChatApproveArgs): Promise<void> => {
    const ctx = ensureAgentChatContext();
    await ctx.agentChatService.approveToolUse(arg);
  });

  ipcMain.handle(IPC.agentChatRespondToInput, async (_event, arg: AgentChatRespondToInputArgs): Promise<void> => {
    const ctx = ensureAgentChatContext();
    await ctx.agentChatService.respondToInput(arg);
  });

  ipcMain.handle(IPC.agentChatModels, async (_event, arg: AgentChatModelsArgs): Promise<AgentChatModelInfo[]> => {
    const ctx = ensureAgentChatContext();
    return await ctx.agentChatService.getAvailableModels(arg);
  });

  ipcMain.handle(IPC.agentChatModelCatalog, async (_event, arg: unknown) => {
    const ctx = ensureAgentChatContext();
    return await ctx.agentChatService.getModelCatalog(arg && typeof arg === "object" ? arg as never : undefined);
  });

  ipcMain.handle(IPC.agentChatArchive, async (_event, arg: AgentChatArchiveArgs): Promise<void> => {
    const ctx = ensureAgentChatContext();
    await ctx.agentChatService.archiveSession(arg);
  });

  ipcMain.handle(IPC.agentChatUnarchive, async (_event, arg: AgentChatArchiveArgs): Promise<void> => {
    const ctx = ensureAgentChatContext();
    await ctx.agentChatService.unarchiveSession(arg);
  });

  ipcMain.handle(IPC.agentChatDelete, async (_event, arg: AgentChatDeleteArgs): Promise<void> => {
    const ctx = ensureAgentChatContext();
    await ctx.agentChatService.deleteSession(arg);
  });

  ipcMain.handle(IPC.agentChatUpdateSession, async (_event, arg: AgentChatUpdateSessionArgs): Promise<AgentChatSession> => {
    const ctx = ensureAgentChatContext();
    return await ctx.agentChatService.updateSession(arg);
  });

  ipcMain.handle(
    IPC.agentChatRecoverContinuity,
    async (_event, arg: AgentChatRecoverContinuityArgs): Promise<AgentChatContinuityRecoveryResult> => {
      const ctx = ensureAgentChatContext();
      return ctx.agentChatService.recoverContinuity(arg);
    },
  );

  ipcMain.handle(
    IPC.agentChatCreateScheduledWork,
    async (_event, arg: AgentChatCreateScheduledWorkArgs): Promise<AgentChatCreateScheduledWorkResult> => {
      const ctx = ensureAgentChatContext();
      return ctx.agentChatService.createScheduledWork(arg);
    },
  );

  ipcMain.handle(
    IPC.agentChatListScheduledWork,
    async (_event, arg: AgentChatListScheduledWorkArgs): Promise<AgentChatScheduledWorkItem[]> => {
      const ctx = ensureAgentChatContext();
      return ctx.agentChatService.listScheduledWork(arg);
    },
  );

  ipcMain.handle(
    IPC.agentChatCancelScheduledWork,
    async (_event, arg: AgentChatCancelScheduledWorkArgs): Promise<AgentChatCancelScheduledWorkResult> => {
      const ctx = ensureAgentChatContext();
      return ctx.agentChatService.cancelScheduledWork(arg);
    },
  );

  ipcMain.handle(
    IPC.agentChatSetScheduledWorkPaused,
    async (_event, arg: AgentChatSetScheduledWorkPausedArgs): Promise<AgentChatSetScheduledWorkPausedResult> => {
      const ctx = ensureAgentChatContext();
      return ctx.agentChatService.setScheduledWorkPaused(arg);
    },
  );

  ipcMain.handle(IPC.agentChatWarmupModel, async (_event, arg: { sessionId: string; modelId: string }): Promise<void> => {
    const ctx = ensureAgentChatContext();
    return ctx.agentChatService.warmupModel(arg);
  });

  ipcMain.handle(IPC.agentChatSlashCommands, async (_event, arg: AgentChatSlashCommandsArgs): Promise<AgentChatSlashCommand[]> => {
    const ctx = ensureAgentChatContext();
    return ctx.agentChatService.getSlashCommands(arg);
  });

  ipcMain.handle(IPC.agentChatCodexGetGoal, async (_event, arg: AgentChatCodexGetGoalArgs): Promise<CodexThreadGoal | null> => {
    const ctx = ensureAgentChatContext();
    return ctx.agentChatService.getCodexGoal(arg);
  });

  ipcMain.handle(IPC.agentChatCodexSetGoal, async (_event, arg: AgentChatCodexSetGoalArgs): Promise<CodexThreadGoal | null> => {
    const ctx = ensureAgentChatContext();
    return ctx.agentChatService.setCodexGoal(arg);
  });

  ipcMain.handle(IPC.agentChatCodexSetGoalStatus, async (_event, arg: AgentChatCodexSetGoalStatusArgs): Promise<CodexThreadGoal | null> => {
    const ctx = ensureAgentChatContext();
    return ctx.agentChatService.setCodexGoalStatus(arg);
  });

  ipcMain.handle(IPC.agentChatCodexClearGoal, async (_event, arg: AgentChatCodexClearGoalArgs): Promise<CodexThreadGoal | null> => {
    const ctx = ensureAgentChatContext();
    return ctx.agentChatService.clearCodexGoal(arg);
  });

  ipcMain.handle(IPC.agentChatListClaudePlugins, async (_event, arg: AgentChatClaudePluginsArgs = {}): Promise<AgentChatClaudePlugin[]> => {
    const ctx = ensureAgentChatContext();
    return ctx.agentChatService.listClaudePlugins(arg);
  });

  ipcMain.handle(IPC.agentChatReloadClaudePlugins, async (_event, arg: AgentChatReloadClaudePluginsArgs): Promise<AgentChatReloadClaudePluginsResult> => {
    const ctx = ensureAgentChatContext();
    return ctx.agentChatService.reloadClaudePlugins(arg);
  });

  ipcMain.handle(IPC.agentChatListClaudeOutputStyles, async (_event, arg: AgentChatClaudeOutputStylesArgs = {}): Promise<AgentChatClaudeOutputStyle[]> => {
    const ctx = ensureAgentChatContext();
    return ctx.agentChatService.listClaudeOutputStyles(arg);
  });

  ipcMain.handle(IPC.agentChatSetClaudeOutputStyle, async (_event, arg: AgentChatSetClaudeOutputStyleArgs): Promise<AgentChatSession> => {
    const ctx = ensureAgentChatContext();
    return await ctx.agentChatService.setClaudeOutputStyle(arg);
  });

  ipcMain.handle(IPC.agentChatListClaudeSessions, async (_event, arg: AgentChatClaudeSessionListArgs = {}): Promise<AgentChatClaudeSessionInfo[]> => {
    const ctx = ensureAgentChatContext();
    return ctx.agentChatService.listClaudeSessions(arg);
  });

  ipcMain.handle(IPC.agentChatGetClaudeSessionInfo, async (_event, arg: AgentChatClaudeSessionInfoArgs): Promise<AgentChatClaudeSessionInfo | null> => {
    const ctx = ensureAgentChatContext();
    return ctx.agentChatService.getClaudeSessionInfo(arg);
  });

  ipcMain.handle(IPC.agentChatGetClaudeSessionMessages, async (_event, arg: AgentChatClaudeSessionMessagesArgs): Promise<AgentChatClaudeSessionMessage[]> => {
    const ctx = ensureAgentChatContext();
    return ctx.agentChatService.getClaudeSessionMessages(arg);
  });

  ipcMain.handle(IPC.agentChatGetMainTranscript, async (_event, arg: AgentChatMainTranscriptArgs): Promise<AgentChatSubagentTranscriptMessage[] | null> => {
    if (!arg || typeof arg.sessionId !== "string" || !arg.sessionId.trim().length) {
      throw new Error("sessionId is required.");
    }
    const ctx = ensureAgentChatContext();
    return ctx.agentChatService.getMainTranscript(arg);
  });

  ipcMain.handle(IPC.agentChatGetSubagentTranscript, async (_event, arg: AgentChatSubagentTranscriptArgs): Promise<AgentChatSubagentTranscriptMessage[] | null> => {
    const ctx = ensureAgentChatContext();
    return ctx.agentChatService.getSubagentTranscript(arg);
  });

  ipcMain.handle(IPC.agentChatGetContextUsage, async (_event, arg: AgentChatContextUsageArgs): Promise<AgentChatContextUsage | null> => {
    const ctx = ensureAgentChatContext();
    return ctx.agentChatService.getContextUsage(arg);
  });

  ipcMain.handle(IPC.agentChatRewindFiles, async (_event, arg: AgentChatRewindFilesArgs): Promise<AgentChatRewindFilesResult> => {
    const ctx = ensureAgentChatContext();
    return ctx.agentChatService.rewindFiles(arg);
  });

  ipcMain.handle(IPC.agentChatFileSearch, async (_event, arg: AgentChatFileSearchArgs): Promise<AgentChatFileSearchResult[]> => {
    const ctx = ensureAgentChatFileContext();
    const session = (await ctx.agentChatService.listSessions()).find((entry) => entry.sessionId === arg.sessionId);
    if (!session?.laneId) return [];
    const matches = await ctx.fileService.quickOpen({
      workspaceId: session.laneId,
      query: arg.query,
      limit: 20,
    });
    return matches.map((match) => ({
      path: match.path,
      score: match.score,
    }));
  });

  ipcMain.handle(IPC.agentChatListSubagents, async (_event, arg: AgentChatSubagentListArgs): Promise<AgentChatSubagentSnapshot[]> => {
    const ctx = ensureAgentChatContext();
    return ctx.agentChatService.listSubagents(arg);
  });

  ipcMain.handle(IPC.agentChatKillDroidWorker, async (_event, arg: AgentChatKillDroidWorkerArgs): Promise<void> => {
    const ctx = ensureAgentChatContext();
    return ctx.agentChatService.killDroidWorker(arg);
  });

  ipcMain.handle(IPC.agentChatGetSessionCapabilities, async (_event, arg: AgentChatSessionCapabilitiesArgs): Promise<AgentChatSessionCapabilities> => {
    const ctx = ensureAgentChatContext();
    return ctx.agentChatService.getSessionCapabilities(arg);
  });

  ipcMain.handle(IPC.agentChatSaveTempAttachment, async (_event, arg: { data: string; filename: string }): Promise<{ path: string }> => {
    const maxEncodedLength = Math.ceil(MAX_TEMP_ATTACHMENT_BYTES / 3) * 4;
    if (typeof arg.data === "string" && arg.data.length > maxEncodedLength) {
      throw new Error("Temporary attachments must be 10 MB or smaller.");
    }
    const content = Buffer.from(arg.data, "base64");
    return saveAgentChatTempAttachmentBuffer(content, arg.filename);
  });

  ipcMain.handle(IPC.agentChatGetTurnFileDiff, async (_event, arg: AgentChatGetTurnFileDiffArgs) => {
    const ctx = getCtx();
    const cwd = ctx.project?.rootPath;
    if (!cwd) throw new Error("No project root");
    const lang = arg.filePath.split(".").pop() ?? undefined;
    const maxSideBytes = MAX_DIFF_SIDE_TEXT_BYTES;
    const readSide = async (spec: string): Promise<{ exists: boolean; text: string; isTruncated?: boolean; isBinary?: boolean }> => {
      const result = await runGit(["show", spec], {
        cwd,
        timeoutMs: 10_000,
        maxOutputBytes: maxSideBytes + 64 * 1024,
      });
      if (result.exitCode !== 0) return { exists: false, text: "" };
      const buf = Buffer.from(result.stdout, "utf8");
      if (buf.includes(0)) return { exists: true, text: "", isBinary: true };
      if (buf.length <= maxSideBytes) return { exists: true, text: result.stdout };
      return {
        exists: true,
        text: appendDiffTruncationNotice(buf.subarray(0, maxSideBytes).toString("utf8")),
        isTruncated: true,
      };
    };
    const origResult = await readSide(`${arg.beforeSha}:${arg.filePath}`);
    const modResult = await readSide(`${arg.afterSha}:${arg.filePath}`);
    return {
      path: arg.filePath,
      mode: "commit",
      language: lang,
      original: origResult,
      modified: modResult,
      ...(origResult.isBinary || modResult.isBinary ? { isBinary: true } : {}),
    };
  });

  ipcMain.handle(IPC.agentChatGetEventHistory, async (
    _event,
    arg: { sessionId?: string; maxEvents?: number },
  ): Promise<AgentChatEventHistorySnapshot> => {
    const ctx = getCtx();
    const sessionId = typeof arg?.sessionId === "string" ? arg.sessionId.trim() : "";
    if (!sessionId) return { sessionId: "", events: [], truncated: false, sessionFound: false };
    const service = ctx.agentChatService;
    if (
      !service ||
      typeof (service as unknown as { getChatEventHistory?: unknown }).getChatEventHistory !== "function"
    ) {
      return { sessionId, events: [], truncated: false, sessionFound: false };
    }
    // Only forward maxEvents when it is a finite positive number; the service
    // layer applies its own clamp but guarding here avoids ambiguous NaN/0
    // inputs from untrusted renderer IPC.
    const rawMaxEvents = typeof arg?.maxEvents === "number" ? arg.maxEvents : undefined;
    const maxEvents =
      rawMaxEvents != null && Number.isFinite(rawMaxEvents) && rawMaxEvents > 0
        ? rawMaxEvents
        : undefined;
    return service.getChatEventHistory(sessionId, maxEvents != null ? { maxEvents } : undefined);
  });

  ipcMain.handle(IPC.agentChatGetEventHistoryPage, async (
    _event,
    arg: { sessionId?: string; beforeOffset?: number; maxBytes?: number },
  ): Promise<AgentChatEventHistoryPage> => {
    const ctx = getCtx();
    const sessionId = typeof arg?.sessionId === "string" ? arg.sessionId.trim() : "";
    if (!sessionId) return { sessionId: "", events: [], startOffset: 0, hasMore: false, sessionFound: false };
    const service = ctx.agentChatService;
    if (
      !service ||
      typeof (service as unknown as { getChatEventHistoryPage?: unknown }).getChatEventHistoryPage !== "function"
    ) {
      return { sessionId, events: [], startOffset: 0, hasMore: false, sessionFound: false };
    }
    const beforeOffset = typeof arg?.beforeOffset === "number" && Number.isFinite(arg.beforeOffset)
      ? arg.beforeOffset
      : 0;
    const rawMaxBytes = typeof arg?.maxBytes === "number" ? arg.maxBytes : undefined;
    const maxBytes = rawMaxBytes != null && Number.isFinite(rawMaxBytes) && rawMaxBytes > 0
      ? rawMaxBytes
      : undefined;
    return service.getChatEventHistoryPage(sessionId, {
      beforeOffset,
      ...(maxBytes != null ? { maxBytes } : {}),
    });
  });

  ipcMain.handle(IPC.agentChatReadTranscript, async (
    _event,
    arg: { sessionId: string; limit?: number; since?: string },
  ) => {
    const ctx = getCtx();
    const service = ctx.agentChatService;
    if (!service || typeof (service as unknown as { readTranscript?: unknown }).readTranscript !== "function") {
      return [];
    }
    const sessionId = typeof arg?.sessionId === "string" ? arg.sessionId.trim() : "";
    if (!sessionId) return [];
    return await (service as unknown as {
      readTranscript: (
        sessionId: string,
        limit?: number,
        since?: string,
      ) => Promise<unknown>;
    }).readTranscript(sessionId, arg?.limit, arg?.since);
  });

  // ---------------------------------------------------------------------------
  // Orchestration (lead/worker/validator runs)
  // ---------------------------------------------------------------------------
  const ensureOrchestration = () => {
    const ctx = getCtx();
    if (!ctx.orchestrationService) {
      throw new Error("orchestration service is not initialised");
    }
    requireAppContextServices(ctx, ["laneService", "agentChatService"] as const);
    return { ctx, service: ctx.orchestrationService };
  };

  let orchestrationBroadcastSubscribed = false;
  const subscribeOrchestrationBroadcast = (): void => {
    if (orchestrationBroadcastSubscribed) return;
    const ctx = getCtx();
    if (!ctx.orchestrationService) return;
    orchestrationBroadcastSubscribed = true;
    ctx.orchestrationService.on("event", (payload) => {
      for (const win of BrowserWindow.getAllWindows()) {
        if (win.isDestroyed()) continue;
        try {
          win.webContents.send(IPC.orchestrationEvent, payload);
        } catch {
          // ignore broadcast failures
        }
      }
    });
  };

  // In-process / test-mode IPC handlers. In every runtime-backed build the
  // renderer routes these through the daemon's "orchestration" action domain
  // (see preload `orchestrationBridge`), so these handlers only fire when the
  // desktop owns the orchestration service directly. Both paths share the same
  // `createOrchestrationDomainService` factory, so behaviour stays identical.
  let cachedOrchestrationDomain:
    | { ctx: ReturnType<typeof getCtx>; domain: ReturnType<typeof createOrchestrationDomainService> }
    | null = null;
  const getOrchestrationDomain = () => {
    const { ctx, service } = ensureOrchestration();
    // ctx identity fully determines the deps (service + laneService + agentChatService
    // all hang off it); reuse the closure object across calls, rebuilding only when the
    // owning context changes (e.g. in-process project switch).
    if (cachedOrchestrationDomain && cachedOrchestrationDomain.ctx === ctx) {
      return cachedOrchestrationDomain.domain;
    }
    const domain = createOrchestrationDomainService({
      orchestrationService: service,
      laneService: {
        getLaneWorktreePath: (laneId: string) => ctx.laneService.getLaneWorktreePath(laneId),
      },
      agentChatService: ctx.agentChatService,
    });
    cachedOrchestrationDomain = { ctx, domain };
    return domain;
  };

  ipcMain.handle(IPC.orchestrationRunCreate, async (_event, arg: OrchestrationRunCreateRequest & { laneId: string }) => {
    subscribeOrchestrationBroadcast();
    return getOrchestrationDomain().runCreate(arg);
  });

  ipcMain.handle(IPC.orchestrationBundleRead, async (_event, arg: { runId: string; laneId: string }) => {
    subscribeOrchestrationBroadcast();
    return getOrchestrationDomain().bundleRead(arg);
  });

  ipcMain.handle(IPC.orchestrationManifestReadSection, async (
    _event,
    arg: { runId: string; laneId: string; section: ManifestSection },
  ) => getOrchestrationDomain().manifestReadSection(arg));

  ipcMain.handle(IPC.orchestrationManifestPatch, async (
    _event,
    arg: OrchestrationManifestPatchRequest & { laneId: string },
  ) => getOrchestrationDomain().manifestPatch(arg));

  ipcMain.handle(IPC.orchestrationPlanAppend, async (
    _event,
    arg: OrchestrationPlanAppendRequest & { laneId: string },
  ) => getOrchestrationDomain().planAppend(arg));

  ipcMain.handle(IPC.orchestrationPlanWrite, async (
    _event,
    arg: OrchestrationPlanWriteRequest & { laneId: string },
  ) => getOrchestrationDomain().planWrite(arg));

  ipcMain.handle(IPC.orchestrationAssetRegister, async (
    _event,
    arg: OrchestrationAssetRegisterRequest & { laneId: string },
  ) => getOrchestrationDomain().assetRegister(arg));

  ipcMain.handle(IPC.orchestrationClaimTask, async (
    _event,
    arg: OrchestrationClaimTaskRequest & { laneId: string },
  ) => getOrchestrationDomain().claimTask(arg));

  ipcMain.handle(IPC.orchestrationReleaseTask, async (
    _event,
    arg: OrchestrationReleaseTaskRequest & { laneId: string },
  ) => getOrchestrationDomain().releaseTask(arg));

  ipcMain.handle(IPC.orchestrationRunList, async (_event, arg: { laneId?: string } = {}) =>
    getOrchestrationDomain().runList(arg),
  );

  ipcMain.handle(IPC.orchestrationSpawnAgent, async (
    _event,
    arg: OrchestrationSpawnAgentRequest & { laneId: string; leadSessionId: string },
  ): Promise<{ sessionId: string; etag: string }> => getOrchestrationDomain().spawnAgent(arg));

  ipcMain.handle(IPC.orchestrationAgentInject, async (
    _event,
    arg: OrchestrationAgentInjectRequest,
  ): Promise<void> => getOrchestrationDomain().agentInject(arg));

  ipcMain.handle(IPC.orchestrationSubscribe, async (_event, arg: { runId: string; laneId?: string }) => {
    const result = await getOrchestrationDomain().subscribe(arg);
    subscribeOrchestrationBroadcast();
    return result;
  });

  ipcMain.handle(IPC.orchestrationUnsubscribe, async (_event, arg: { runId: string }) =>
    getOrchestrationDomain().unsubscribe(arg),
  );

  ipcMain.handle(IPC.computerUseListArtifacts, async (_event, arg: ComputerUseArtifactListArgs = {}): Promise<ComputerUseArtifactView[]> => {
    const ctx = ensureComputerUseBroker();
    return ctx.computerUseArtifactBrokerService.listArtifacts(arg);
  });

  ipcMain.handle(IPC.computerUseGetOwnerSnapshot, async (_event, arg: ComputerUseOwnerSnapshotArgs): Promise<ComputerUseOwnerSnapshot> => {
    const ctx = ensureComputerUseBroker();
    const resolved = await resolveComputerUseOwnerSnapshotArgs(ctx, arg);
    return buildComputerUseOwnerSnapshot({
      broker: ctx.computerUseArtifactBrokerService,
      owner: resolved.owner,
      limit: resolved.limit,
    });
  });

  ipcMain.handle(IPC.computerUseRouteArtifact, async (_event, arg: ComputerUseArtifactRouteArgs): Promise<ComputerUseArtifactView> => {
    const ctx = ensureComputerUseBroker();
    return ctx.computerUseArtifactBrokerService.routeArtifact(arg);
  });

  ipcMain.handle(IPC.computerUseUpdateArtifactReview, async (_event, arg: ComputerUseArtifactReviewArgs): Promise<ComputerUseArtifactView> => {
    const ctx = ensureComputerUseBroker();
    return ctx.computerUseArtifactBrokerService.updateArtifactReview(arg);
  });

  ipcMain.handle(IPC.computerUseReadArtifactPreview, async (_event, arg: { uri: string }): Promise<string | null> => {
    const ctx = ensureComputerUseBroker();
    return ctx.computerUseArtifactBrokerService.readArtifactPreview(arg);
  });

  ipcMain.handle(IPC.iosSimulatorGetStatus, async () => ensureIosSimulator().getStatus());

  ipcMain.handle(IPC.iosSimulatorListDevices, async () => ensureIosSimulator().listDevices());

  ipcMain.handle(IPC.iosSimulatorListLaunchTargets, async (_event, arg = {}) =>
    ensureIosSimulator().listLaunchTargets(arg));

  const simulatorWindowName = /(?:^|\s|[(\[\-–])(simulator|iphone|ipad|apple\s*watch|apple\s*tv|vision\s*pro)(?:\s|[)\]\-–]|$)/i;
  const runMacUtility = async (command: string, args: string[], timeoutMs = 900) => {
    await new Promise<void>((resolve) => {
      const child = spawn(command, args, { stdio: "ignore" });
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        child.removeAllListeners("error");
        child.removeAllListeners("exit");
        resolve();
      };
      const timeout = setTimeout(() => {
        try { child.kill("SIGTERM"); } catch { /* already gone */ }
        setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* already gone */ } }, 250);
        finish();
      }, timeoutMs);
      child.once("error", finish);
      child.once("exit", finish);
    });
  };
  const runMacUtilityText = async (command: string, args: string[], timeoutMs = 900): Promise<string> => {
    return new Promise<string>((resolve, reject) => {
      const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      const timeout = setTimeout(() => {
        child.kill("SIGTERM");
        reject(new Error(`${command} timed out.`));
      }, timeoutMs);
      child.stdout?.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      child.once("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      child.once("exit", (code) => {
        clearTimeout(timeout);
        if (code === 0) {
          resolve(stdout.trim());
          return;
        }
        reject(new Error(stderr.trim() || `${command} exited with code ${code ?? "unknown"}.`));
      });
    });
  };
  const windowIssueMessage = (issue: IosSimulatorWindowState["issue"]): string | null => {
    switch (issue) {
      case "not-running":
        return "The simulator is not running. Launch it from ADE again.";
      case "hidden":
        return "The simulator is hidden. Show it to refresh the live view.";
      case "minimized":
        return "The simulator is minimized. Restore it to refresh the live view.";
      case "no-window":
        return "The simulator is running, but ADE cannot find a visible simulator window.";
      default:
        return null;
    }
  };
  const getSimulatorWindowState = async (): Promise<IosSimulatorWindowState> => {
    if (process.platform !== "darwin") {
      return {
        appRunning: false,
        visible: null,
        windowCount: null,
        minimizedWindowCount: null,
        capturable: false,
        issue: "unknown",
        message: null,
      };
    }
    const script = [
      'tell application "System Events"',
      '  if not (exists process "Simulator") then return "not-running|false|0|0"',
      '  tell process "Simulator"',
      '    set processVisible to visible',
      '    set windowCount to count windows',
      '    set minimizedCount to 0',
      '    repeat with simulatorWindow in windows',
      '      try',
      '        if value of attribute "AXMinimized" of simulatorWindow then set minimizedCount to minimizedCount + 1',
      '      end try',
      '    end repeat',
      '    return (processVisible as text) & "|" & (windowCount as text) & "|" & (minimizedCount as text)',
      '  end tell',
      'end tell',
    ].join("\n");
    try {
      const raw = await runMacUtilityText("osascript", ["-e", script], 900);
      if (raw.startsWith("not-running")) {
        const issue: IosSimulatorWindowState["issue"] = "not-running";
        return {
          appRunning: false,
          visible: false,
          windowCount: 0,
          minimizedWindowCount: 0,
          capturable: false,
          issue,
          message: windowIssueMessage(issue),
        };
      }
      const [visibleRaw, windowCountRaw, minimizedCountRaw] = raw.split("|");
      const visible = visibleRaw === "true";
      const windowCount = Number.parseInt(windowCountRaw ?? "", 10);
      const minimizedWindowCount = Number.parseInt(minimizedCountRaw ?? "", 10);
      const hasWindows = Number.isFinite(windowCount) && windowCount > 0;
      const allWindowsMinimized = hasWindows && Number.isFinite(minimizedWindowCount) && minimizedWindowCount >= windowCount;
      const issue: IosSimulatorWindowState["issue"] = !visible
        ? "hidden"
        : !hasWindows
          ? "no-window"
          : allWindowsMinimized
            ? "minimized"
            : null;
      return {
        appRunning: true,
        visible,
        windowCount: Number.isFinite(windowCount) ? windowCount : null,
        minimizedWindowCount: Number.isFinite(minimizedWindowCount) ? minimizedWindowCount : null,
        capturable: issue === null,
        issue,
        message: windowIssueMessage(issue),
      };
    } catch {
      return {
        appRunning: true,
        visible: null,
        windowCount: null,
        minimizedWindowCount: null,
        capturable: null,
        issue: "unknown",
        message: null,
      };
    }
  };
  const focusBrowserWindow = (window: BrowserWindow | null) => {
    if (!window) return;
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  };
  const prepareSimulatorWindowForCapture = async (window: BrowserWindow | null, options: { placeBehindAde?: boolean } = {}) => {
    await runMacUtility("open", ["-g", "-a", "Simulator"], 900);
    const bounds = options.placeBehindAde && window ? window.getBounds() : null;
    const targetWidth = bounds ? Math.max(300, Math.min(440, Math.round(bounds.width * 0.34))) : 0;
    const targetHeight = bounds ? Math.max(520, Math.min(860, bounds.height - 120)) : 0;
    // Park the real Simulator window under ADE, but away from the drawer.
    // Window capture needs the window to stay unminimized; placing it under
    // the left side avoids capturing the user's cursor while they interact
    // with the simulator surface on the right.
    const targetX = bounds ? Math.round(bounds.x + Math.max(64, Math.min(140, bounds.width * 0.08))) : 0;
    const targetY = bounds ? Math.round(bounds.y + 72) : 0;
    const script = [
      'tell application "System Events"',
      '  if exists process "Simulator" then',
      '    tell process "Simulator"',
      '      set visible to true',
      '      repeat with simulatorWindow in windows',
      '        try',
      '          set value of attribute "AXMinimized" of simulatorWindow to false',
      '        end try',
      bounds
        ? [
            '        try',
            `          set position of simulatorWindow to {${targetX}, ${targetY}}`,
            `          set size of simulatorWindow to {${Math.round(targetWidth)}, ${Math.round(targetHeight)}}`,
            '        end try',
          ].join("\n")
        : "",
      '      end repeat',
      '    end tell',
      '  end if',
      'end tell',
    ].filter(Boolean).join("\n");
    await runMacUtility("osascript", ["-e", script], 1_200);
    focusBrowserWindow(window);
  };
  let simulatorParkingWindow: BrowserWindow | null = null;
  let simulatorParkingTimer: NodeJS.Timeout | null = null;
  let cleanupSimulatorParkingFollow: (() => void) | null = null;
  const scheduleSimulatorParking = (window: BrowserWindow) => {
    if (simulatorParkingTimer) clearTimeout(simulatorParkingTimer);
    simulatorParkingTimer = setTimeout(() => {
      simulatorParkingTimer = null;
      if (window.isDestroyed()) return;
      void prepareSimulatorWindowForCapture(window, { placeBehindAde: true }).catch(() => {});
    }, 120);
  };
  const followSimulatorWindowUnderAde = (window: BrowserWindow | null) => {
    if (!window || window.isDestroyed()) return;
    if (simulatorParkingWindow === window) {
      return;
    }
    cleanupSimulatorParkingFollow?.();
    simulatorParkingWindow = window;
    const onBoundsChanged = () => scheduleSimulatorParking(window);
    const onClosed = () => {
      cleanupSimulatorParkingFollow?.();
    };
    window.on("move", onBoundsChanged);
    window.on("resize", onBoundsChanged);
    window.once("closed", onClosed);
    cleanupSimulatorParkingFollow = () => {
      if (simulatorParkingTimer) {
        clearTimeout(simulatorParkingTimer);
        simulatorParkingTimer = null;
      }
      if (!window.isDestroyed()) {
        window.off("move", onBoundsChanged);
        window.off("resize", onBoundsChanged);
        window.off("closed", onClosed);
      }
      if (simulatorParkingWindow === window) simulatorParkingWindow = null;
      cleanupSimulatorParkingFollow = null;
    };
  };
  const activeSimulatorParkingWindow = (): BrowserWindow | null => {
    if (!simulatorParkingWindow || simulatorParkingWindow.isDestroyed()) return null;
    return simulatorParkingWindow;
  };
  const claimSimulatorParkingWindow = (
    window: BrowserWindow | null,
    options: { force?: boolean } = {},
  ): BrowserWindow | null => {
    const current = activeSimulatorParkingWindow();
    if (current && !options.force) {
      return current;
    }
    if (!window || window.isDestroyed()) return current;
    followSimulatorWindowUnderAde(window);
    return window;
  };

  ipcMain.handle(IPC.iosSimulatorLaunch, async (event, arg = {}) => {
    const result = await ensureIosSimulator().launch(arg);
    const keepSimulatorInBackgroundPayload = (arg as { keepSimulatorInBackground?: unknown } | null)?.keepSimulatorInBackground;
    const keepSimulatorInBackground = keepSimulatorInBackgroundPayload === true;
    if (!keepSimulatorInBackground) {
      const browserWindow = BrowserWindow.fromWebContents(event.sender);
      const parkingWindow = claimSimulatorParkingWindow(browserWindow, { force: true });
      await prepareSimulatorWindowForCapture(parkingWindow, { placeBehindAde: true });
    }
    return result;
  });

  ipcMain.handle(IPC.iosSimulatorAttachToChatSession, async (_event, arg) => {
    // Tolerate null/undefined payloads (treated as detach) and reject malformed
    // shapes with a clear error rather than throwing on a property dereference.
    if (arg !== undefined && arg !== null && typeof arg !== "object") {
      throw new Error("iosSimulatorAttachToChatSession requires { chatSessionId } payload.");
    }
    const payload = (arg ?? {}) as { chatSessionId?: string | null; callerChatSessionId?: string | null };
    const chatSessionId = payload.chatSessionId ?? null;
    const callerChatSessionId = payload.callerChatSessionId ?? chatSessionId;
    return ensureIosSimulator().attachToChatSession(chatSessionId, callerChatSessionId);
  });

  ipcMain.handle(IPC.iosSimulatorShutdown, async (_event, arg = {}) => {
    cleanupSimulatorParkingFollow?.();
    return ensureIosSimulator().shutdown(arg);
  });

  ipcMain.handle(IPC.iosSimulatorScreenshot, async (_event, arg = {}) => ensureIosSimulator().screenshot(arg));

  ipcMain.handle(IPC.iosSimulatorGetScreenSnapshot, async (_event, arg = {}) =>
    ensureIosSimulator().getScreenSnapshot(arg));

  ipcMain.handle(IPC.iosSimulatorGetInspectorSnapshot, async (_event, arg = {}) =>
    ensureIosSimulator().getInspectorSnapshot(arg));

  ipcMain.handle(IPC.iosSimulatorInspectPoint, async (_event, arg) => ensureIosSimulator().inspectPoint(arg));

  ipcMain.handle(IPC.iosSimulatorGetPreviewCapability, async (_event, arg = {}) =>
    ensureIosSimulator().getPreviewCapability(arg));

  ipcMain.handle(IPC.iosSimulatorListPreviewTargets, async (_event, arg = {}) =>
    ensureIosSimulator().listPreviewTargets(arg));

  ipcMain.handle(IPC.iosSimulatorResolvePreviewMatch, async (_event, arg = {}) =>
    ensureIosSimulator().resolvePreviewMatch(arg));

  ipcMain.handle(IPC.iosSimulatorEnsurePreviewWorkspace, async (_event, arg = {}) =>
    ensureIosSimulator().ensurePreviewWorkspace(arg));

  ipcMain.handle(IPC.iosSimulatorRenderCurrentPreview, async (_event, arg = {}) =>
    ensureIosSimulator().renderCurrentPreview(arg));

  ipcMain.handle(IPC.iosSimulatorRenderPreview, async (_event, arg) => ensureIosSimulator().renderPreview(arg));

  ipcMain.handle(IPC.iosSimulatorOpenPreviewWorkspace, async (_event, arg = {}) =>
    ensureIosSimulator().openPreviewWorkspace(arg));

  ipcMain.handle(IPC.iosSimulatorStartStream, async (event, arg = {}) => {
    const result = await ensureIosSimulator().startStream(arg);
    if (result.backend === "simulator-window-capture") {
      const browserWindow = BrowserWindow.fromWebContents(event.sender);
      const parkingWindow = claimSimulatorParkingWindow(browserWindow);
      await prepareSimulatorWindowForCapture(parkingWindow, { placeBehindAde: true });
    }
    return result;
  });

  ipcMain.handle(IPC.iosSimulatorStopStream, async () => ensureIosSimulator().stopStream());

  ipcMain.handle(IPC.iosSimulatorGetStreamStatus, async () => ensureIosSimulator().getStreamStatus());

  ipcMain.handle(IPC.iosSimulatorGetWindowState, async () => getSimulatorWindowState());

  ipcMain.handle(IPC.iosSimulatorListWindowSources, async (event, arg = {}) => {
    const status = await getIosSimulatorStatusForEvent(event, arg, IPC.iosSimulatorListWindowSources);
    if (!status.supported) return [];
    const readSources = async () => desktopCapturer.getSources({
      types: ["window"],
      thumbnailSize: { width: 320, height: 320 },
    });
    const senderWindow = BrowserWindow.fromWebContents(event.sender);
    const parkingWindow = status.activeSession
      ? claimSimulatorParkingWindow(senderWindow)
      : null;
    if (status.activeSession) {
      await prepareSimulatorWindowForCapture(parkingWindow, { placeBehindAde: true });
      await new Promise((resolve) => setTimeout(resolve, 350));
    }
    let sources = await readSources();
    if (status.activeSession && !sources.some((source) => simulatorWindowName.test(source.name))) {
      await prepareSimulatorWindowForCapture(parkingWindow, { placeBehindAde: true });
      await new Promise((resolve) => setTimeout(resolve, 650));
      sources = await readSources();
    }
    return sources
      .filter((source) => simulatorWindowName.test(source.name))
      .map((source) => ({
        id: source.id,
        name: source.name,
        thumbnailDataUrl: source.thumbnail.isEmpty() ? null : source.thumbnail.toDataURL(),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  });

  ipcMain.handle(IPC.iosSimulatorTap, async (_event, arg) => ensureIosSimulator().tap(arg));

  ipcMain.handle(IPC.iosSimulatorTypeText, async (_event, arg) => ensureIosSimulator().typeText(arg));

  ipcMain.handle(IPC.iosSimulatorDrag, async (_event, arg) => ensureIosSimulator().drag(arg));

  ipcMain.handle(IPC.iosSimulatorSwipe, async (_event, arg) => ensureIosSimulator().swipe(arg));

  ipcMain.handle(IPC.iosSimulatorSelectPoint, async (_event, arg) => ensureIosSimulator().selectPoint(arg));

  ipcMain.handle(IPC.appControlGetStatus, async (event) => {
    guardAppControlIpc(event, IPC.appControlGetStatus, { windowMs: 10_000, max: 80 });
    return ensureAppControl().getStatus();
  });

  ipcMain.handle(IPC.appControlLaunch, async (event, arg) => {
    guardAppControlIpc(event, IPC.appControlLaunch, { windowMs: 60_000, max: 10 });
    return ensureAppControl().launch(parseAppControlLaunchArgs(arg, IPC.appControlLaunch));
  });

  ipcMain.handle(IPC.appControlLaunchInTerminal, async (event, arg) => {
    guardAppControlIpc(event, IPC.appControlLaunchInTerminal, { windowMs: 60_000, max: 10 });
    return ensureAppControl().launchInTerminal(parseAppControlLaunchArgs(arg, IPC.appControlLaunchInTerminal));
  });

  ipcMain.handle(IPC.appControlConnect, async (event, arg) => {
    guardAppControlIpc(event, IPC.appControlConnect, { windowMs: 60_000, max: 20 });
    return ensureAppControl().connect(parseAppControlConnectArgs(arg, IPC.appControlConnect));
  });

  ipcMain.handle(IPC.appControlStop, async (event, arg) => {
    guardAppControlIpc(event, IPC.appControlStop, { windowMs: 10_000, max: 20 });
    return ensureAppControl().stop(parseAppControlStopArgs(arg, IPC.appControlStop));
  });

  ipcMain.handle(IPC.appControlFocusWindow, async (event) => {
    guardAppControlIpc(event, IPC.appControlFocusWindow, { windowMs: 10_000, max: 20 });
    return ensureAppControl().focusWindow();
  });

  ipcMain.handle(IPC.appControlMinimizeWindow, async (event) => {
    guardAppControlIpc(event, IPC.appControlMinimizeWindow, { windowMs: 10_000, max: 20 });
    return ensureAppControl().minimizeWindow();
  });

  ipcMain.handle(IPC.appControlScreenshot, async (event) => {
    guardAppControlIpc(event, IPC.appControlScreenshot, { windowMs: 10_000, max: 30 });
    return ensureAppControl().screenshot();
  });

  ipcMain.handle(IPC.appControlGetSnapshot, async (event, arg) => {
    guardAppControlIpc(event, IPC.appControlGetSnapshot, { windowMs: 10_000, max: 30 });
    return ensureAppControl().getSnapshot(parseAppControlSnapshotArgs(arg, IPC.appControlGetSnapshot));
  });

  ipcMain.handle(IPC.appControlInspectPoint, async (event, arg) => {
    guardAppControlIpc(event, IPC.appControlInspectPoint, { windowMs: 10_000, max: 60 });
    return ensureAppControl().inspectPoint(parseAppControlPointArgs(arg, IPC.appControlInspectPoint));
  });

  ipcMain.handle(IPC.appControlSelectPoint, async (event, arg) => {
    guardAppControlIpc(event, IPC.appControlSelectPoint, { windowMs: 10_000, max: 40 });
    return ensureAppControl().selectPoint(parseAppControlPointArgs(arg, IPC.appControlSelectPoint));
  });

  ipcMain.handle(IPC.appControlClick, async (event, arg) => {
    guardAppControlIpc(event, IPC.appControlClick, { windowMs: 10_000, max: 30 });
    return ensureAppControl().click(parseAppControlClickArgs(arg, IPC.appControlClick));
  });

  ipcMain.handle(IPC.appControlTypeText, async (event, arg) => {
    guardAppControlIpc(event, IPC.appControlTypeText, { windowMs: 10_000, max: 20 });
    return ensureAppControl().typeText(parseAppControlTypeTextArgs(arg, IPC.appControlTypeText));
  });

  ipcMain.handle(IPC.appControlScroll, async (event, arg) => {
    guardAppControlIpc(event, IPC.appControlScroll, { windowMs: 10_000, max: 600 });
    const record = isRecord(arg) ? arg : {};
    const finiteNumberOr = (key: string, fallback: number | null): number | null => {
      const raw = record[key];
      if (raw === undefined || raw === null) return fallback;
      if (typeof raw !== "number" || !Number.isFinite(raw)) {
        throw new Error(`appControlScroll: '${key}' must be a finite number`);
      }
      return raw;
    };
    return ensureAppControl().scroll({
      x: finiteNumberOr("x", 0) as number,
      y: finiteNumberOr("y", 0) as number,
      deltaX: finiteNumberOr("deltaX", 0) as number,
      deltaY: finiteNumberOr("deltaY", 0) as number,
      scale: finiteNumberOr("scale", null),
      coordinateSpace: optionalAppControlCoordinateSpace(record, IPC.appControlScroll),
    });
  });

  ipcMain.handle(IPC.appControlListTargets, async (event) => {
    guardAppControlIpc(event, IPC.appControlListTargets, { windowMs: 10_000, max: 60 });
    return ensureAppControl().listTargets();
  });

  ipcMain.handle(IPC.appControlAttachToTarget, async (event, arg) => {
    guardAppControlIpc(event, IPC.appControlAttachToTarget, { windowMs: 10_000, max: 30 });
    const rawTargetId = isRecord(arg) ? arg.targetId : null;
    if (typeof rawTargetId !== "string" || rawTargetId.length === 0) {
      throw new Error("appControlAttachToTarget: 'targetId' must be a non-empty string");
    }
    return ensureAppControl().attachToTarget(rawTargetId);
  });

  ipcMain.handle(IPC.appControlDispatchKey, async (event, arg) => {
    guardAppControlIpc(event, IPC.appControlDispatchKey, { windowMs: 10_000, max: 600 });
    const record = isRecord(arg) ? arg : {};
    const stringField = (key: string): string | null => (typeof record[key] === "string" ? record[key] as string : null);
    const numberField = (key: string): number | null => (typeof record[key] === "number" ? record[key] as number : null);
    const boolField = (key: string): boolean | null => (typeof record[key] === "boolean" ? record[key] as boolean : null);
    const rawType = record.type;
    if (rawType !== "keyDown" && rawType !== "keyUp" && rawType !== "rawKeyDown" && rawType !== "char") {
      throw new Error(`appControlDispatchKey: 'type' must be one of keyDown|keyUp|rawKeyDown|char (got ${typeof rawType === "string" ? JSON.stringify(rawType) : typeof rawType})`);
    }
    const type = rawType;
    return ensureAppControl().dispatchKey({
      type,
      key: stringField("key"),
      code: stringField("code"),
      text: stringField("text"),
      unmodifiedText: stringField("unmodifiedText"),
      modifiers: numberField("modifiers"),
      autoRepeat: boolField("autoRepeat"),
      isKeypad: boolField("isKeypad"),
      location: numberField("location"),
      windowsVirtualKeyCode: numberField("windowsVirtualKeyCode"),
      nativeVirtualKeyCode: numberField("nativeVirtualKeyCode"),
    });
  });

  ipcMain.handle(IPC.builtInBrowserGetStatus, async (event, arg) => {
    const win = guardBuiltInBrowserIpc(event, IPC.builtInBrowserGetStatus, { windowMs: 10_000, max: 120 });
    return ensureBuiltInBrowser().getStatus(parseBuiltInBrowserProjectScopeInput(arg, IPC.builtInBrowserGetStatus), win);
  });

  ipcMain.handle(IPC.builtInBrowserRequestOriginAccess, async (event, arg) => {
    const win = guardBuiltInBrowserIpc(event, IPC.builtInBrowserRequestOriginAccess, { windowMs: 10_000, max: 10 });
    return ensureBuiltInBrowser().requestOriginAccess(
      parseBuiltInBrowserTabTargetArgs(arg, IPC.builtInBrowserRequestOriginAccess),
      win,
    );
  });

  ipcMain.handle(IPC.builtInBrowserGetProfileDiagnostics, async (event) => {
    guardBuiltInBrowserIpc(event, IPC.builtInBrowserGetProfileDiagnostics, { windowMs: 10_000, max: 20 });
    return ensureBuiltInBrowser().getProfileDiagnostics();
  });

  ipcMain.handle(IPC.builtInBrowserListPermissions, async (event) => {
    guardBuiltInBrowserIpc(event, IPC.builtInBrowserListPermissions, { windowMs: 10_000, max: 20 });
    return ensureBuiltInBrowser().listPermissions();
  });

  ipcMain.handle(IPC.builtInBrowserClearPermissions, async (event, arg) => {
    guardBuiltInBrowserIpc(event, IPC.builtInBrowserClearPermissions, { windowMs: 10_000, max: 10 });
    return ensureBuiltInBrowser().clearPermissions(
      parseBuiltInBrowserClearPermissionsArgs(arg, IPC.builtInBrowserClearPermissions),
    );
  });

  ipcMain.handle(IPC.builtInBrowserShowPanel, async (event, arg) => {
    const win = guardBuiltInBrowserIpc(event, IPC.builtInBrowserShowPanel, { windowMs: 10_000, max: 80 });
    return ensureBuiltInBrowser().showPanel(parseBuiltInBrowserOpenPanelArgs(arg, IPC.builtInBrowserShowPanel), win);
  });

  ipcMain.handle(IPC.builtInBrowserSetBounds, async (event, arg) => {
    const win = guardBuiltInBrowserIpc(event, IPC.builtInBrowserSetBounds, { windowMs: 10_000, max: 900 });
    return ensureBuiltInBrowser().setBounds(parseBuiltInBrowserBoundsArgs(arg, IPC.builtInBrowserSetBounds), win);
  });

  ipcMain.handle(IPC.builtInBrowserAttachWebview, async (event, arg) => {
    const win = guardBuiltInBrowserIpc(event, IPC.builtInBrowserAttachWebview, { windowMs: 10_000, max: 120 });
    return ensureBuiltInBrowser().attachWebview(parseBuiltInBrowserAttachWebviewArgs(arg, IPC.builtInBrowserAttachWebview), win);
  });

  ipcMain.handle(IPC.builtInBrowserNavigate, async (event, arg) => {
    const win = guardBuiltInBrowserIpc(event, IPC.builtInBrowserNavigate, { windowMs: 60_000, max: 40 });
    return ensureBuiltInBrowser().navigate(parseBuiltInBrowserNavigateArgs(arg, IPC.builtInBrowserNavigate), win);
  });

  ipcMain.handle(IPC.builtInBrowserCreateTab, async (event, arg) => {
    const win = guardBuiltInBrowserIpc(event, IPC.builtInBrowserCreateTab, { windowMs: 60_000, max: 40 });
    return ensureBuiltInBrowser().createTab(parseBuiltInBrowserCreateTabArgs(arg, IPC.builtInBrowserCreateTab), win);
  });

  ipcMain.handle(IPC.builtInBrowserSwitchTab, async (event, arg) => {
    const win = guardBuiltInBrowserIpc(event, IPC.builtInBrowserSwitchTab, { windowMs: 10_000, max: 120 });
    return ensureBuiltInBrowser().switchTab(parseBuiltInBrowserTabArgs(arg, IPC.builtInBrowserSwitchTab), win);
  });

  ipcMain.handle(IPC.builtInBrowserCloseTab, async (event, arg) => {
    const win = guardBuiltInBrowserIpc(event, IPC.builtInBrowserCloseTab, { windowMs: 10_000, max: 80 });
    return ensureBuiltInBrowser().closeTab(parseBuiltInBrowserTabArgs(arg, IPC.builtInBrowserCloseTab), win);
  });

  ipcMain.handle(IPC.builtInBrowserReload, async (event, arg) => {
    const win = guardBuiltInBrowserIpc(event, IPC.builtInBrowserReload, { windowMs: 10_000, max: 60 });
    return ensureBuiltInBrowser().reload(parseBuiltInBrowserTabTargetArgs(arg, IPC.builtInBrowserReload), win);
  });

  ipcMain.handle(IPC.builtInBrowserGoBack, async (event, arg) => {
    const win = guardBuiltInBrowserIpc(event, IPC.builtInBrowserGoBack, { windowMs: 10_000, max: 80 });
    return ensureBuiltInBrowser().goBack(parseBuiltInBrowserTabTargetArgs(arg, IPC.builtInBrowserGoBack), win);
  });

  ipcMain.handle(IPC.builtInBrowserGoForward, async (event, arg) => {
    const win = guardBuiltInBrowserIpc(event, IPC.builtInBrowserGoForward, { windowMs: 10_000, max: 80 });
    return ensureBuiltInBrowser().goForward(parseBuiltInBrowserTabTargetArgs(arg, IPC.builtInBrowserGoForward), win);
  });

  ipcMain.handle(IPC.builtInBrowserStop, async (event, arg) => {
    const win = guardBuiltInBrowserIpc(event, IPC.builtInBrowserStop, { windowMs: 10_000, max: 80 });
    return ensureBuiltInBrowser().stop(parseBuiltInBrowserTabTargetArgs(arg, IPC.builtInBrowserStop), win);
  });

  ipcMain.handle(IPC.builtInBrowserStartInspect, async (event, arg) => {
    const win = guardBuiltInBrowserIpc(event, IPC.builtInBrowserStartInspect, { windowMs: 10_000, max: 40 });
    return ensureBuiltInBrowser().startInspect(parseBuiltInBrowserProjectScopeInput(arg, IPC.builtInBrowserStartInspect), win);
  });

  ipcMain.handle(IPC.builtInBrowserStopInspect, async (event, arg) => {
    const win = guardBuiltInBrowserIpc(event, IPC.builtInBrowserStopInspect, { windowMs: 10_000, max: 80 });
    return ensureBuiltInBrowser().stopInspect(parseBuiltInBrowserProjectScopeInput(arg, IPC.builtInBrowserStopInspect), win);
  });

  ipcMain.handle(IPC.builtInBrowserCaptureScreenshot, async (event, arg) => {
    const win = guardBuiltInBrowserIpc(event, IPC.builtInBrowserCaptureScreenshot, { windowMs: 10_000, max: 30 });
    return ensureBuiltInBrowser().captureScreenshot(parseBuiltInBrowserTabTargetArgs(arg, IPC.builtInBrowserCaptureScreenshot), win);
  });

  ipcMain.handle(IPC.builtInBrowserSelectPoint, async (event, arg) => {
    const win = guardBuiltInBrowserIpc(event, IPC.builtInBrowserSelectPoint, { windowMs: 10_000, max: 80 });
    return ensureBuiltInBrowser().selectPoint(parseBuiltInBrowserSelectPointArgs(arg, IPC.builtInBrowserSelectPoint), win);
  });

  ipcMain.handle(IPC.builtInBrowserSelectCurrent, async (event, arg) => {
    const win = guardBuiltInBrowserIpc(event, IPC.builtInBrowserSelectCurrent, { windowMs: 10_000, max: 80 });
    return ensureBuiltInBrowser().selectCurrent(parseBuiltInBrowserProjectScopeInput(arg, IPC.builtInBrowserSelectCurrent), win);
  });

  ipcMain.handle(IPC.builtInBrowserClearSelection, async (event, arg) => {
    const win = guardBuiltInBrowserIpc(event, IPC.builtInBrowserClearSelection, { windowMs: 10_000, max: 80 });
    return ensureBuiltInBrowser().clearSelection(parseBuiltInBrowserProjectScopeInput(arg, IPC.builtInBrowserClearSelection), win);
  });

  const requirePtyService = (): ReturnType<typeof createPtyService> => {
    const service = getCtx().ptyService;
    if (!service) {
      throw new Error("ADE terminal service is not available for this project window. Reopen the project and try again.");
    }
    return service;
  };

  ipcMain.handle(IPC.ptyCreate, async (_event, arg: PtyCreateArgs): Promise<PtyCreateResult> => {
    return await requirePtyService().create(arg);
  });

  ipcMain.handle(IPC.ptyResumeSession, async (_event, arg: PtyResumeSessionArgs): Promise<PtyResumeSessionResult> => {
    return await requirePtyService().resumeSession(arg);
  });

  ipcMain.handle(IPC.ptySendToSession, async (_event, arg: PtySendToSessionArgs): Promise<PtySendToSessionResult> => {
    return await requirePtyService().sendToSession(arg);
  });

  ipcMain.handle(IPC.ptyWrite, async (_event, arg: { ptyId: string; data: string }): Promise<void> => {
    requirePtyService().write(arg);
  });

  ipcMain.handle(IPC.ptyResize, async (_event, arg: { ptyId: string; cols: number; rows: number }): Promise<void> => {
    requirePtyService().resize(arg);
  });

  ipcMain.handle(IPC.ptyDispose, async (_event, arg: { ptyId: string; sessionId?: string }): Promise<PtyDisposeResult> => {
    return requirePtyService().dispose(arg);
  });

  ipcMain.handle(IPC.terminalList, async (_event, arg) =>
    requirePtyService().listTerminals(parseTerminalListArgs(arg)),
  );

  ipcMain.handle(IPC.terminalRead, async (_event, arg) =>
    requirePtyService().readTerminal(parseTerminalReadArgs(arg)),
  );

  ipcMain.handle(IPC.terminalPreview, async (_event, arg) =>
    requirePtyService().previewTerminal(parseTerminalPreviewArgs(arg)),
  );

  ipcMain.handle(IPC.terminalWrite, async (_event, arg) =>
    await requirePtyService().writeTerminal(parseTerminalWriteArgs(arg)),
  );

  ipcMain.handle(IPC.terminalSignal, async (_event, arg) =>
    requirePtyService().signalTerminal(parseTerminalSignalArgs(arg)),
  );

  ipcMain.handle(IPC.terminalActiveForChat, async (_event, arg) =>
    requirePtyService().activeForChat(parseTerminalActiveForChatArgs(arg)),
  );

  ipcMain.handle(IPC.terminalReattachChatCli, async (_event, arg) =>
    await requirePtyService().reattachChatCli(parseTerminalReattachArgs(arg)),
  );

  const ensureDiffContext = (): AppContextWith<"diffService"> => {
    const ctx = getCtx();
    requireAppContextServices(ctx, ["diffService"] as const);
    return ctx;
  };

  const ensureFileContext = (): AppContextWith<"fileService"> => {
    const ctx = getCtx();
    requireAppContextServices(ctx, ["fileService"] as const);
    return ctx;
  };

  const ensureGitContext = (): AppContextWith<"gitService"> => {
    const ctx = getCtx();
    requireAppContextServices(ctx, ["gitService"] as const);
    return ctx;
  };

  const ensureGitLaneContext = (): AppContextWith<"gitService" | "laneService"> => {
    const ctx = getCtx();
    requireAppContextServices(ctx, ["gitService", "laneService"] as const);
    return ctx;
  };

  const ensureConflictContext = (): AppContextWith<"conflictService"> => {
    const ctx = getCtx();
    requireAppContextServices(ctx, ["conflictService"] as const);
    return ctx;
  };

  const ensureConflictJobContext = (): AppContextWith<"conflictService" | "jobEngine"> => {
    const ctx = getCtx();
    requireAppContextServices(ctx, ["conflictService", "jobEngine"] as const);
    return ctx;
  };

  ipcMain.handle(IPC.diffGetChanges, async (_event, arg: GetDiffChangesArgs) => {
    const ctx = ensureDiffContext();
    return await withIpcTiming(ctx, "diff.getChanges", async () => await ctx.diffService.getChanges(arg.laneId), {
      laneId: arg.laneId,
    });
  });

  ipcMain.handle(IPC.diffGetFile, async (_event, arg: GetFileDiffArgs) => {
    const ctx = ensureDiffContext();
    return await withIpcTiming(
      ctx,
      "diff.getFile",
      async () => await ctx.diffService.getFileDiff({
        laneId: arg.laneId,
        filePath: arg.path,
        mode: arg.mode,
        compareRef: arg.compareRef,
        compareTo: arg.compareTo
      }),
      {
        laneId: arg.laneId,
        mode: arg.mode,
        pathLength: arg.path.length,
      }
    );
  });

  ipcMain.handle(IPC.diffGetFilePatch, async (_event, arg: GetFilePatchArgs) => {
    const ctx = ensureDiffContext();
    return await withIpcTiming(
      ctx,
      "diff.getFilePatch",
      async () => await ctx.diffService.getFilePatch({
        laneId: arg.laneId,
        filePath: arg.path,
        mode: arg.mode,
        compareRef: arg.compareRef,
        compareTo: arg.compareTo
      }),
      {
        laneId: arg.laneId,
        mode: arg.mode,
        pathLength: arg.path.length,
      }
    );
  });

  ipcMain.handle(IPC.filesWriteTextAtomic, async (_event, arg: WriteTextAtomicArgs): Promise<void> => {
    const ctx = ensureFileContext();
    ctx.fileService.writeTextAtomic({ laneId: arg.laneId, relPath: arg.path, text: arg.text });
  });

  ipcMain.handle(IPC.filesListWorkspaces, async (_event, arg: FilesListWorkspacesArgs = {}): Promise<FilesWorkspace[]> => {
    const ctx = ensureFileContext();
    return ctx.fileService.listWorkspaces(arg);
  });

  ipcMain.handle(IPC.filesListTree, async (_event, arg: FilesListTreeArgs): Promise<FileTreeNode[]> => {
    const ctx = ensureFileContext();
    return await withIpcTiming(
      ctx,
      "files.listTree",
      async () => await ctx.fileService.listTree(arg),
      {
        workspaceId: arg.workspaceId,
        hasParentPath: Boolean(arg.parentPath),
        depth: arg.depth
      }
    );
  });

  ipcMain.handle(IPC.filesListTreeChildren, async (_event, arg: FilesListTreeChildrenArgs): Promise<FilesListTreeChildrenResult> => {
    const ctx = ensureFileContext();
    return await withIpcTiming(
      ctx,
      "files.listTreeChildren",
      async () => await ctx.fileService.listTreeChildren(arg),
      {
        workspaceId: arg.workspaceId,
        offset: arg.offset,
        limit: arg.limit,
      }
    );
  });

  ipcMain.handle(IPC.filesRefreshGitDecorations, async (_event, arg: FilesRefreshGitDecorationsArgs): Promise<FilesGitStatusEvent> => {
    const ctx = ensureFileContext();
    return await withIpcTiming(
      ctx,
      "files.refreshGitDecorations",
      async () => await ctx.fileService.refreshGitDecorations(arg),
      {
        workspaceId: arg.workspaceId,
        forceFresh: Boolean(arg.forceFresh),
      }
    );
  });

  ipcMain.handle(IPC.filesOpenExternalPath, async (event, arg: FilesOpenExternalPathArgs): Promise<FilesOpenExternalPathResult> => {
    assertTrustedFilesSender(event, "files.openExternalPath");
    const ctx = ensureFileContext();
    return await withIpcTiming(
      ctx,
      "files.openExternalPath",
      async () => await ctx.fileService.openExternalPath(arg),
      {
        pathLength: arg.path.length,
      }
    );
  });

  ipcMain.handle(IPC.filesReadFile, async (_event, arg: FilesReadFileArgs): Promise<FileContent> => {
    const ctx = ensureFileContext();
    return await withIpcTiming(
      ctx,
      "files.readFile",
      async () => await ctx.fileService.readFile(arg),
      {
        workspaceId: arg.workspaceId,
        pathLength: arg.path.length,
      }
    );
  });

  ipcMain.handle(IPC.filesReadFileRange, async (_event, arg: FilesReadFileRangeArgs): Promise<FilesReadFileRangeResult> => {
    const ctx = ensureFileContext();
    return await withIpcTiming(
      ctx,
      "files.readFileRange",
      async () => await ctx.fileService.readFileRange(arg),
      {
        workspaceId: arg.workspaceId,
        offset: arg.offset,
        length: arg.length,
      }
    );
  });

  ipcMain.handle(IPC.filesGitBlame, async (_event, arg: FilesGitBlameArgs): Promise<FilesGitBlameResult> => {
    const ctx = ensureFileContext();
    return await withIpcTiming(
      ctx,
      "files.gitBlame",
      async () => await ctx.fileService.blame(arg),
      {
        workspaceId: arg.workspaceId,
        hasRange: Boolean(arg.startLine && arg.endLine),
      }
    );
  });

  ipcMain.handle(IPC.filesWriteText, async (_event, arg: FilesWriteTextArgs): Promise<void> => {
    const ctx = ensureFileContext();
    ctx.fileService.writeWorkspaceText(arg);
  });

  ipcMain.handle(IPC.filesCreateFile, async (_event, arg: FilesCreateFileArgs): Promise<void> => {
    const ctx = ensureFileContext();
    ctx.fileService.createFile(arg);
  });

  ipcMain.handle(IPC.filesCreateDirectory, async (_event, arg: FilesCreateDirectoryArgs): Promise<void> => {
    const ctx = ensureFileContext();
    ctx.fileService.createDirectory(arg);
  });

  ipcMain.handle(IPC.filesRename, async (_event, arg: FilesRenameArgs): Promise<void> => {
    const ctx = ensureFileContext();
    ctx.fileService.rename(arg);
  });

  ipcMain.handle(IPC.filesDelete, async (_event, arg: FilesDeleteArgs): Promise<void> => {
    const ctx = ensureFileContext();
    ctx.fileService.deletePath(arg);
  });

  ipcMain.handle(IPC.filesWatchChanges, async (event, arg: FilesWatchArgs): Promise<void> => {
    const ctx = ensureFileContext();
    const senderId = event.sender.id;
    if (!watcherCleanupBoundSenders.has(senderId)) {
      watcherCleanupBoundSenders.add(senderId);
      event.sender.once("destroyed", () => {
        watcherCleanupBoundSenders.delete(senderId);
        try {
          getCtx().fileService?.stopWatchingBySender(senderId);
        } catch {
          // context may already be disposed/switched
        }
      });
    }
    await ctx.fileService.watchWorkspace(arg, (payload: FileChangeEvent) => {
      try {
        event.sender.send(IPC.filesChange, payload);
      } catch {
        // ignore detached renderer
      }
    }, senderId);
  });

  ipcMain.handle(IPC.filesStopWatching, async (event, arg: FilesWatchArgs): Promise<void> => {
    const ctx = ensureFileContext();
    ctx.fileService.stopWatching(arg, event.sender.id);
  });

  ipcMain.handle(IPC.filesQuickOpen, async (_event, arg: FilesQuickOpenArgs): Promise<FilesQuickOpenItem[]> => {
    const ctx = ensureFileContext();
    return await ctx.fileService.quickOpen(arg);
  });

  ipcMain.handle(IPC.filesSearchText, async (_event, arg: FilesSearchTextArgs): Promise<FilesSearchTextMatch[]> => {
    const ctx = ensureFileContext();
    return await ctx.fileService.searchText(arg);
  });

  ipcMain.handle(IPC.gitStageFile, async (_event, arg: GitFileActionArgs): Promise<GitActionResult> => {
    const ctx = ensureGitContext();
    return ctx.gitService.stageFile(arg);
  });

  ipcMain.handle(IPC.gitStageAll, async (_event, arg: GitBatchFileActionArgs): Promise<GitActionResult> => {
    const ctx = ensureGitContext();
    return ctx.gitService.stageAll(arg);
  });

  ipcMain.handle(IPC.gitUnstageFile, async (_event, arg: GitFileActionArgs): Promise<GitActionResult> => {
    const ctx = ensureGitContext();
    return ctx.gitService.unstageFile(arg);
  });

  ipcMain.handle(IPC.gitUnstageAll, async (_event, arg: GitBatchFileActionArgs): Promise<GitActionResult> => {
    const ctx = ensureGitContext();
    return ctx.gitService.unstageAll(arg);
  });

  ipcMain.handle(IPC.gitDiscardFile, async (_event, arg: GitFileActionArgs): Promise<GitActionResult> => {
    const ctx = ensureGitContext();
    return ctx.gitService.discardFile(arg);
  });

  ipcMain.handle(IPC.gitRestoreStagedFile, async (_event, arg: GitFileActionArgs): Promise<GitActionResult> => {
    const ctx = ensureGitContext();
    return ctx.gitService.restoreStagedFile(arg);
  });

  ipcMain.handle(IPC.gitCommit, async (_event, arg: GitCommitArgs): Promise<GitActionResult> => {
    const ctx = ensureGitContext();
    return ctx.gitService.commit(arg);
  });

  ipcMain.handle(
    IPC.gitGenerateCommitMessage,
    async (_event, arg: GitGenerateCommitMessageArgs): Promise<GitGenerateCommitMessageResult> => {
      const ctx = getCtx();
      requireAppContextServices(ctx, ["gitService"] as const);
      return ctx.gitService.generateCommitMessage(arg);
    }
  );

  ipcMain.handle(IPC.gitListRecentCommits, async (_event, arg: { laneId: string; limit?: number }): Promise<GitCommitSummary[]> => {
    const ctx = ensureGitContext();
    return ctx.gitService.listRecentCommits(arg);
  });

  ipcMain.handle(IPC.gitListCommitFiles, async (_event, arg: GitListCommitFilesArgs): Promise<string[]> => {
    const ctx = ensureGitContext();
    return await ctx.gitService.listCommitFiles(arg);
  });

  ipcMain.handle(IPC.gitGetCommitMessage, async (_event, arg: GitGetCommitMessageArgs): Promise<string> => {
    const ctx = ensureGitContext();
    return await ctx.gitService.getCommitMessage(arg);
  });

  ipcMain.handle(
    IPC.gitGetCommit,
    async (_event, arg: { laneId: string; commitSha: string }): Promise<GitCommitSummary | null> => {
      const ctx = getCtx();
      requireAppContextServices(ctx, ["gitService"] as const);
      return await ctx.gitService.getCommit(arg);
    },
  );

  ipcMain.handle(
    IPC.gitIsCommitInLaneHistory,
    async (_event, arg: { laneId: string; commitSha: string }): Promise<boolean> => {
      const ctx = getCtx();
      requireAppContextServices(ctx, ["gitService"] as const);
      return await ctx.gitService.isCommitInLaneHistory(arg);
    },
  );

  ipcMain.handle(IPC.gitRevertCommit, async (_event, arg: GitRevertArgs): Promise<GitActionResult> => {
    const ctx = ensureGitContext();
    return ctx.gitService.revertCommit(arg);
  });

  ipcMain.handle(IPC.gitCherryPickCommit, async (_event, arg: GitCherryPickArgs): Promise<GitActionResult> => {
    const ctx = ensureGitContext();
    return ctx.gitService.cherryPickCommit(arg);
  });

  ipcMain.handle(IPC.gitCreateTag, async (_event, arg: GitCreateTagArgs): Promise<GitActionResult> => {
    const ctx = ensureGitContext();
    return ctx.gitService.createTag(arg);
  });

  ipcMain.handle(IPC.gitResetToCommit, async (_event, arg: GitResetCommitArgs): Promise<GitActionResult> => {
    const ctx = ensureGitContext();
    return ctx.gitService.resetToCommit(arg);
  });

  ipcMain.handle(IPC.gitStashPush, async (_event, arg: GitStashPushArgs): Promise<GitActionResult> => {
    const ctx = ensureGitContext();
    return ctx.gitService.stashPush(arg);
  });

  ipcMain.handle(IPC.gitStashList, async (_event, arg: { laneId: string }): Promise<GitStashSummary[]> => {
    const ctx = ensureGitContext();
    return ctx.gitService.listStashes(arg);
  });

  ipcMain.handle(IPC.gitStashApply, async (_event, arg: GitStashRefArgs): Promise<GitActionResult> => {
    const ctx = ensureGitContext();
    return ctx.gitService.stashApply(arg);
  });

  ipcMain.handle(IPC.gitStashPop, async (_event, arg: GitStashRefArgs): Promise<GitActionResult> => {
    const ctx = ensureGitContext();
    return ctx.gitService.stashPop(arg);
  });

  ipcMain.handle(IPC.gitStashDrop, async (_event, arg: GitStashRefArgs): Promise<GitActionResult> => {
    const ctx = ensureGitContext();
    return ctx.gitService.stashDrop(arg);
  });

  ipcMain.handle(IPC.gitStashClear, async (_event, arg: { laneId: string }): Promise<GitActionResult> => {
    const ctx = ensureGitContext();
    return ctx.gitService.stashClear(arg);
  });

  ipcMain.handle(IPC.gitFetch, async (_event, arg: { laneId: string }): Promise<GitActionResult> => {
    const ctx = ensureGitContext();
    return ctx.gitService.fetch(arg);
  });

  ipcMain.handle(IPC.gitPull, async (_event, arg: GitPullArgs): Promise<GitActionResult> => {
    const ctx = ensureGitContext();
    return ctx.gitService.pull(arg);
  });

  ipcMain.handle(IPC.gitUndoLastHeadChange, async (_event, arg: GitHeadChangeActionArgs): Promise<GitActionResult> => {
    const ctx = ensureGitContext();
    return ctx.gitService.undoLastHeadChange(arg);
  });

  ipcMain.handle(IPC.gitRedoLastHeadChange, async (_event, arg: GitHeadChangeActionArgs): Promise<GitActionResult> => {
    const ctx = ensureGitContext();
    return ctx.gitService.redoLastHeadChange(arg);
  });

  ipcMain.handle(IPC.gitGetSyncStatus, async (_event, arg: { laneId: string }): Promise<GitUpstreamSyncStatus> => {
    const ctx = ensureGitContext();
    return await ctx.gitService.getSyncStatus(arg);
  });

  ipcMain.handle(IPC.gitGetOriginRemote, async (_event, arg: { laneId: string }): Promise<{ remoteUrl: string | null; branch: string | null }> => {
    const ctx = ensureGitLaneContext();
    const laneId = typeof arg?.laneId === "string" ? arg.laneId.trim() : "";
    const fallback = { remoteUrl: null, branch: null } as const;
    if (!laneId) return fallback;
    let worktreePath: string;
    let knownBranch: string | null = null;
    try {
      const info = ctx.laneService.getLaneBaseAndBranch(laneId);
      worktreePath = info.worktreePath;
      knownBranch = info.branchRef?.trim() || null;
    } catch {
      return fallback;
    }
    if (!worktreePath) return fallback;
    const [remoteRes, branchRes] = await Promise.all([
      runGit(["remote", "get-url", "origin"], { cwd: worktreePath, timeoutMs: 8_000 }).catch(() => null),
      knownBranch
        ? Promise.resolve(null)
        : runGit(["rev-parse", "--abbrev-ref", "HEAD"], { cwd: worktreePath, timeoutMs: 8_000 }).catch(() => null),
    ]);
    const rawRemote = remoteRes?.exitCode === 0 ? remoteRes.stdout.trim() || null : null;
    // Strip embedded credentials/userinfo (e.g. https://user:token@host/...)
    // before exposing the URL to the renderer, so secrets do not cross the IPC
    // boundary.
    const remoteUrl = ((): string | null => {
      if (!rawRemote) return rawRemote;
      try {
        const parsed = new URL(rawRemote);
        if (parsed.username || parsed.password) {
          parsed.username = "";
          parsed.password = "";
          return parsed.toString();
        }
        return rawRemote;
      } catch {
        // Non-URL form (e.g. SSH `git@host:owner/repo.git`) — return unchanged;
        // these never embed user credentials.
        return rawRemote;
      }
    })();
    let branch = knownBranch;
    if (!branch && branchRes && branchRes.exitCode === 0) {
      const out = branchRes.stdout.trim();
      branch = out && out !== "HEAD" ? out : null;
    }
    return { remoteUrl, branch };
  });

  ipcMain.handle(IPC.gitGetOpenPrForBranch, async (_event, arg: { laneId: string; branch?: string }): Promise<{ prUrl: string | null; prNumber: number | null; title: string | null; headRefName: string | null }> => {
    const ctx = ensureGitLaneContext();
    const fallback = { prUrl: null, prNumber: null, title: null, headRefName: null } as const;
    const laneId = typeof arg?.laneId === "string" ? arg.laneId.trim() : "";
    if (!laneId) return fallback;
    let worktreePath: string;
    let laneBranch: string | null = null;
    try {
      const info = ctx.laneService.getLaneBaseAndBranch(laneId);
      worktreePath = info.worktreePath;
      laneBranch = info.branchRef?.trim() || null;
    } catch {
      return fallback;
    }
    if (!worktreePath) return fallback;
    const requestedBranch = typeof arg?.branch === "string" ? arg.branch.trim() : "";
    const branch = requestedBranch || laneBranch;
    if (!branch) return fallback;

    try {
      const stdout = await new Promise<string>((resolve) => {
        let settled = false;
        let out = "";
        const child = spawn("gh", ["pr", "list", "--head", branch, "--state", "open", "--json", "url,number,title,headRefName", "--limit", "1"], {
          cwd: worktreePath,
          env: process.env,
          stdio: ["ignore", "pipe", "pipe"],
        });
        const finish = (value: string) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          try { child.kill("SIGKILL"); } catch { /* noop */ }
          resolve(value);
        };
        const timer = setTimeout(() => finish(""), 8_000);
        child.stdout.on("data", (d: Buffer | string) => {
          out += Buffer.isBuffer(d) ? d.toString("utf8") : String(d);
        });
        child.stderr.on("data", () => { /* swallow — may contain auth state */ });
        child.on("error", () => finish(""));
        child.on("close", (code) => finish(code === 0 ? out : ""));
      });
      if (!stdout.trim()) return fallback;
      const parsed: unknown = JSON.parse(stdout);
      if (!Array.isArray(parsed) || parsed.length === 0) return fallback;
      const entry = parsed[0] as Record<string, unknown>;
      const prUrl = typeof entry.url === "string" && entry.url ? entry.url : null;
      const prNumber = typeof entry.number === "number" ? entry.number : null;
      const title = typeof entry.title === "string" && entry.title ? entry.title : null;
      const headRefName = typeof entry.headRefName === "string" && entry.headRefName ? entry.headRefName : null;
      return { prUrl, prNumber, title, headRefName };
    } catch {
      return fallback;
    }
  });

  ipcMain.handle(IPC.gitSync, async (_event, arg: GitSyncArgs): Promise<GitActionResult> => {
    const ctx = ensureGitContext();
    return ctx.gitService.sync(arg);
  });

  ipcMain.handle(IPC.gitPush, async (_event, arg: GitPushArgs): Promise<GitActionResult> => {
    const ctx = ensureGitLaneContext();
    const result = await ctx.gitService.push(arg);
    const lane = await ctx.laneService
      .list({ includeArchived: true, includeStatus: false })
      .then((lanes) => lanes.find((entry) => entry.id === arg.laneId) ?? null)
      .catch(() => null);
    ctx.automationService?.onGitPushed?.({
      laneId: arg.laneId,
      branchRef: lane?.branchRef ?? null,
      summary: lane ? `Pushed ${lane.branchRef}` : "Pushed branch",
    });
    return result;
  });

  ipcMain.handle(IPC.gitGetConflictState, async (_event, arg: { laneId: string }): Promise<GitConflictState> => {
    const ctx = ensureGitContext();
    return await ctx.gitService.getConflictState({ laneId: arg?.laneId ?? "" });
  });

  ipcMain.handle(IPC.gitRebaseContinue, async (_event, arg: { laneId: string }): Promise<GitActionResult> => {
    const ctx = ensureGitContext();
    return await ctx.gitService.rebaseContinue({ laneId: arg?.laneId ?? "" });
  });

  ipcMain.handle(IPC.gitRebaseAbort, async (_event, arg: { laneId: string }): Promise<GitActionResult> => {
    const ctx = ensureGitContext();
    return await ctx.gitService.rebaseAbort({ laneId: arg?.laneId ?? "" });
  });

  ipcMain.handle(IPC.gitMergeContinue, async (_event, arg: { laneId: string }): Promise<GitActionResult> => {
    const ctx = ensureGitContext();
    return await ctx.gitService.mergeContinue({ laneId: arg?.laneId ?? "" });
  });

  ipcMain.handle(IPC.gitMergeAbort, async (_event, arg: { laneId: string }): Promise<GitActionResult> => {
    const ctx = ensureGitContext();
    return await ctx.gitService.mergeAbort({ laneId: arg?.laneId ?? "" });
  });

  ipcMain.handle(IPC.gitListBranches, async (_event, arg: GitListBranchesArgs): Promise<GitBranchSummary[]> => {
    const ctx = ensureGitContext();
    return await ctx.gitService.listBranches(arg);
  });

  ipcMain.handle(IPC.gitGetUserIdentity, async (_event, arg: GitGetUserIdentityArgs): Promise<GitUserIdentity> => {
    const ctx = ensureGitContext();
    return await ctx.gitService.getUserIdentity(arg);
  });

  ipcMain.handle(IPC.gitCheckoutBranch, async (_event, arg: GitCheckoutBranchArgs): Promise<GitActionResult> => {
    const ctx = ensureGitContext();
    return await ctx.gitService.checkoutBranch(arg);
  });

  ipcMain.handle(IPC.conflictsGetLaneStatus, async (_event, arg: GetLaneConflictStatusArgs): Promise<ConflictStatus> => {
    const ctx = ensureConflictContext();
    return await ctx.conflictService.getLaneStatus(arg);
  });

  ipcMain.handle(IPC.conflictsListOverlaps, async (_event, arg: ListOverlapsArgs): Promise<ConflictOverlap[]> => {
    const ctx = ensureConflictContext();
    return await ctx.conflictService.listOverlaps(arg);
  });

  ipcMain.handle(IPC.conflictsGetRiskMatrix, async (): Promise<RiskMatrixEntry[]> => {
    const ctx = ensureConflictContext();
    return await ctx.conflictService.getRiskMatrix();
  });

  ipcMain.handle(IPC.conflictsSimulateMerge, async (_event, arg: MergeSimulationArgs): Promise<MergeSimulationResult> => {
    const ctx = ensureConflictContext();
    return await ctx.conflictService.simulateMerge(arg);
  });

  ipcMain.handle(IPC.conflictsRunPrediction, async (_event, arg: RunConflictPredictionArgs = {}): Promise<BatchAssessmentResult> => {
    const ctx = ensureConflictContext();
    return await ctx.conflictService.runPrediction(arg);
  });

  ipcMain.handle(IPC.conflictsGetBatchAssessment, async (): Promise<BatchAssessmentResult> => {
    const ctx = ensureConflictContext();
    return await ctx.conflictService.getBatchAssessment();
  });

  ipcMain.handle(IPC.conflictsListProposals, async (_event, arg: { laneId: string }): Promise<ConflictProposal[]> => {
    const ctx = ensureConflictContext();
    return await ctx.conflictService.listProposals(arg);
  });

  ipcMain.handle(IPC.conflictsPrepareProposal, async (_event, arg: PrepareConflictProposalArgs): Promise<ConflictProposalPreview> => {
    const ctx = ensureConflictContext();
    return await ctx.conflictService.prepareProposal(arg);
  });

  ipcMain.handle(IPC.conflictsRequestProposal, async (_event, arg: RequestConflictProposalArgs): Promise<ConflictProposal> => {
    const ctx = ensureConflictContext();
    return await ctx.conflictService.requestProposal(arg);
  });

  ipcMain.handle(IPC.conflictsApplyProposal, async (_event, arg: ApplyConflictProposalArgs): Promise<ConflictProposal> => {
    const ctx = ensureConflictJobContext();
    const updated = await ctx.conflictService.applyProposal(arg);
    ctx.jobEngine.runConflictPredictionNow({ laneId: arg.laneId });
    return updated;
  });

  ipcMain.handle(IPC.conflictsUndoProposal, async (_event, arg: UndoConflictProposalArgs): Promise<ConflictProposal> => {
    const ctx = ensureConflictJobContext();
    const updated = await ctx.conflictService.undoProposal(arg);
    ctx.jobEngine.runConflictPredictionNow({ laneId: arg.laneId });
    return updated;
  });

  ipcMain.handle(IPC.conflictsRunExternalResolver, async (_event, arg: RunExternalConflictResolverArgs): Promise<ConflictExternalResolverRunSummary> => {
    const ctx = ensureConflictContext();
    return await ctx.conflictService.runExternalResolver(arg);
  });

  ipcMain.handle(IPC.conflictsListExternalResolverRuns, async (_event, arg: ListExternalConflictResolverRunsArgs = {}): Promise<ConflictExternalResolverRunSummary[]> => {
    const ctx = ensureConflictContext();
    return ctx.conflictService.listExternalResolverRuns(arg);
  });

  ipcMain.handle(
    IPC.conflictsCommitExternalResolverRun,
    async (_event, arg: CommitExternalConflictResolverRunArgs): Promise<CommitExternalConflictResolverRunResult> => {
      const ctx = getCtx();
      requireAppContextServices(ctx, ["conflictService", "jobEngine"] as const);
      const committed = await ctx.conflictService.commitExternalResolverRun(arg);
      ctx.jobEngine.runConflictPredictionNow({ laneId: committed.laneId });
      return committed;
    }
  );

  ipcMain.handle(IPC.conflictsPrepareResolverSession, async (_event, arg) => ensureConflictContext().conflictService.prepareResolverSession(arg));

  ipcMain.handle(IPC.conflictsAttachResolverSession, async (_event, arg: AttachResolverSessionArgs) =>
    ensureConflictContext().conflictService.attachResolverSession(arg)
  );

  ipcMain.handle(IPC.conflictsFinalizeResolverSession, async (_event, arg) => ensureConflictContext().conflictService.finalizeResolverSession(arg));

  ipcMain.handle(IPC.conflictsCancelResolverSession, async (_event, arg: CancelResolverSessionArgs) =>
    ensureConflictContext().conflictService.cancelResolverSession(arg)
  );

  ipcMain.handle(IPC.conflictsSuggestResolverTarget, async (_event, arg) => ensureConflictContext().conflictService.suggestResolverTarget(arg));

  const broadcastGithubStatus = (status: GitHubStatus): void => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isDestroyed()) continue;
      try {
        win.webContents.send(IPC.githubStatusChanged, status);
      } catch {
        // ignore broadcast failures
      }
    }
  };

  ipcMain.handle(IPC.githubGetStatus, async (_event, arg?: { forceRefresh?: boolean }): Promise<GitHubStatus> => {
    const ctx = getCtx();
    return await ctx.githubService.getStatus({ forceRefresh: Boolean(arg?.forceRefresh) });
  });

  ipcMain.handle(IPC.githubGetRemoteStatus, async (): Promise<{ repo: GitHubRepoRef | null; hasOrigin: boolean }> => {
    const ctx = getCtx();
    return await ctx.githubService.getRemoteStatus();
  });

  ipcMain.handle(IPC.githubSetToken, async (_event, arg: { token: string }): Promise<GitHubStatus> => {
    const ctx = getCtx();
    ctx.githubService.setToken(arg.token);
    const status = await ctx.githubService.getStatus();
    broadcastGithubStatus(status);
    return status;
  });

  ipcMain.handle(IPC.githubClearToken, async (): Promise<GitHubStatus> => {
    const ctx = getCtx();
    ctx.githubService.clearToken();
    const status = await ctx.githubService.getStatus();
    broadcastGithubStatus(status);
    return status;
  });

  ipcMain.handle(IPC.githubGetAppUserAuthStatus, async (): Promise<GitHubAppUserAuthStatus> => {
    const ctx = getCtx();
    return ctx.githubService.getAppUserAuthStatus();
  });

  ipcMain.handle(IPC.githubStartAppUserDeviceAuth, async (): Promise<GitHubAppDeviceAuthStartResult> => {
    const ctx = getCtx();
    return await ctx.githubService.startAppUserDeviceAuth();
  });

  ipcMain.handle(
    IPC.githubPollAppUserDeviceAuth,
    async (_event, arg: { sessionId?: string }): Promise<GitHubAppDeviceAuthPollResult> => {
      const ctx = getCtx();
      const sessionId = arg?.sessionId?.trim() ?? "";
      if (!sessionId) {
        return {
          status: "error",
          intervalSec: null,
          message: "GitHub device authorization session id is required.",
          authStatus: ctx.githubService.getAppUserAuthStatus(),
        };
      }
      return await ctx.githubService.pollAppUserDeviceAuth({ sessionId });
    },
  );

  ipcMain.handle(IPC.githubClearAppUserAuth, async (): Promise<GitHubAppUserAuthStatus> => {
    const ctx = getCtx();
    return ctx.githubService.clearAppUserAuth();
  });

  const resolveGithubRepoRef = async (
    githubService: ReturnType<typeof createGithubService>,
    arg?: { owner?: string; name?: string } | null
  ): Promise<{ owner: string; name: string }> => {
    const owner = arg?.owner?.trim();
    const name = arg?.name?.trim();
    if (owner && name) return { owner, name };
    const detected = await githubService.detectRepo();
    if (!detected) {
      throw new Error("Unable to detect GitHub repo from git remote 'origin'. Provide owner/name explicitly.");
    }
    return detected;
  };

  ipcMain.handle(IPC.githubListRepoLabels, async (_event, arg: { owner?: string; name?: string }) => {
    const ctx = getCtx();
    const { owner, name } = await resolveGithubRepoRef(ctx.githubService, arg);
    return await ctx.githubService.listRepoLabels(owner, name);
  });

  ipcMain.handle(IPC.githubGetAppInstallationStatus, async (_event, arg: { owner?: string; name?: string } = {}) => {
    const ctx = getCtx();
    return await ctx.githubService.getAppInstallationStatus(arg);
  });

  ipcMain.handle(IPC.githubListRepoAutolinks, async (_event, arg: { owner?: string; name?: string }): Promise<GitHubAutolink[]> => {
    const ctx = getCtx();
    const { owner, name } = await resolveGithubRepoRef(ctx.githubService, arg);
    return await ctx.githubService.listRepoAutolinks(owner, name);
  });

  ipcMain.handle(
    IPC.githubCreateRepoAutolink,
    async (_event, arg: {
      owner?: string;
      name?: string;
      keyPrefix?: string;
      urlTemplate?: string;
      isAlphanumeric?: boolean;
    }): Promise<GitHubAutolink> => {
      const ctx = getCtx();
      const { owner, name } = await resolveGithubRepoRef(ctx.githubService, arg);
      const keyPrefix = arg?.keyPrefix?.trim() ?? "";
      const urlTemplate = arg?.urlTemplate?.trim() ?? "";
      if (!keyPrefix) throw new Error("Autolink key prefix is required.");
      if (!urlTemplate || !urlTemplate.includes("<num>")) {
        throw new Error("Autolink URL template must include <num>.");
      }
      return await ctx.githubService.createRepoAutolink(owner, name, {
        keyPrefix,
        urlTemplate,
        isAlphanumeric: arg?.isAlphanumeric === true,
      });
    },
  );

  ipcMain.handle(IPC.githubListRepoCollaborators, async (_event, arg: { owner?: string; name?: string }) => {
    const ctx = getCtx();
    const { owner, name } = await resolveGithubRepoRef(ctx.githubService, arg);
    return await ctx.githubService.listRepoCollaborators(owner, name);
  });

  ipcMain.handle(IPC.githubListRepoIssues, async (_event, arg: { owner?: string; name?: string; state?: "open" | "closed" | "all"; since?: string }) => {
    const ctx = getCtx();
    const { owner, name } = await resolveGithubRepoRef(ctx.githubService, arg);
    return await ctx.githubService.listRepoIssues(owner, name, {
      state: arg?.state ?? "all",
      since: arg?.since,
    });
  });

  ipcMain.handle(
    IPC.githubListMyRepos,
    async (_event, arg: ListMyGitHubReposInput = {}): Promise<ListMyGitHubReposResult> => {
      const search = typeof arg?.search === "string" ? arg.search.trim() : undefined;
      const ctx = getCtx();
      try {
        return await ctx.projectScaffoldService.listMyGitHubRepos(
          search ? { search } : {},
        );
      } catch (error) {
        return surfaceCodedError(error);
      }
    },
  );

  ipcMain.handle(
	    IPC.githubPublishCurrentProject,
	    async (_event, arg: PublishProjectInput): Promise<PublishProjectResult> => {
	      const owner = typeof arg?.owner === "string" ? arg.owner.trim() : undefined;
	      const name = typeof arg?.name === "string" ? arg.name.trim() : "";
	      const description = typeof arg?.description === "string" ? arg.description.trim() : undefined;
	      const isPrivate = arg?.isPrivate !== false;
	      if (!name) throw new Error("Repository name is required.");
      const ctx = getCtx();
      const projectRoot = ctx.project?.rootPath ?? "";
      if (!projectRoot) {
        throw new Error("No active project to publish.");
      }
	      try {
	        return await ctx.githubService.publishCurrentProject({
	          ...(owner ? { owner } : {}),
	          name,
	          ...(description ? { description } : {}),
	          isPrivate,
	        });
      } catch (error) {
        return surfaceCodedError(error);
      }
    },
  );

  // ── Feedback Reporter ──────────────────────────────────────────────
  ipcMain.handle(IPC.feedbackPrepareDraft, async (_event, arg: FeedbackPrepareDraftArgs): Promise<FeedbackPreparedDraft> => {
    const ctx = getCtx();
    if (!ctx.feedbackReporterService) throw new Error("Feedback reporter not available");
    return await ctx.feedbackReporterService.prepareDraft(arg);
  });

  ipcMain.handle(IPC.feedbackSubmitDraft, async (_event, arg: FeedbackSubmitDraftArgs): Promise<FeedbackSubmission> => {
    const ctx = getCtx();
    if (!ctx.feedbackReporterService) throw new Error("Feedback reporter not available");
    return await ctx.feedbackReporterService.submitPreparedDraft(arg);
  });

  ipcMain.handle(IPC.feedbackList, async (): Promise<FeedbackSubmission[]> => {
    const ctx = getCtx();
    if (!ctx.feedbackReporterService) return [];
    return ctx.feedbackReporterService.list();
  });

  // Machine-owned ADE account (Clerk identity, #815). The bridge owns the auth
  // service in main and only ever exposes the token-free surface to the
  // renderer — getToken is deliberately never wired here.
  const accountBridge = createAccountBridge({
    getProjectRoot: () => getCtx().project.rootPath ?? null,
    reconcileAccountOwnership: runtimeBridge.reconcileAccountOwnership,
    logger: {
      info: (message, meta) => getCtx().logger.info(message, meta),
      warn: (message, meta) => getCtx().logger.warn(message, meta),
    },
  });

  ipcMain.handle(IPC.accountStatus, async (): Promise<AdeAccountStatus> => {
    return accountBridge.status();
  });

  ipcMain.handle(
    IPC.accountGetLocalMachineIdentity,
    async (): Promise<AdeAccountLocalMachineIdentity> => {
      return runtimeBridge.getLocalMachineIdentity();
    },
  );

  ipcMain.handle(IPC.accountStartLogin, async (): Promise<AdeAccountLoginStart> => {
    return accountBridge.startLogin();
  });

  ipcMain.handle(
    IPC.accountPollLogin,
    async (_event, arg: { sessionId?: string }): Promise<AdeAccountLoginPoll> => {
      return accountBridge.pollLogin(arg?.sessionId ?? "");
    },
  );

  ipcMain.handle(
    IPC.accountCancelLogin,
    async (_event, arg: { sessionId?: string }): Promise<AdeAccountStatus> => {
      accountBridge.cancelLogin(arg?.sessionId ?? "");
      return accountBridge.status();
    },
  );

  ipcMain.handle(IPC.accountSignOut, async (): Promise<AdeAccountStatus> => {
    return accountBridge.signOut();
  });

  ipcMain.handle(IPC.accountListMachines, async (): Promise<AdeAccountMachinesResult> => {
    return accountBridge.listMachines();
  });

  ipcMain.handle(
    IPC.accountPairMachine,
    async (_event, arg: { machineKey?: string }): Promise<AdeAccountMachinePairResult> => {
      return await accountBridge.pairMachine(arg?.machineKey ?? "");
    },
  );

  ipcMain.handle(
    IPC.accountRemoveMachine,
    async (
      _event,
      arg: { machineKey?: string },
    ): Promise<AdeAccountMachineRemovalResult> => {
      return await accountBridge.removeMachine(arg?.machineKey ?? "");
    },
  );

  const ensurePrMutationContext = (): AppContextWith<"prService" | "prPollingService"> => {
    const ctx = getCtx();
    requireAppContextServices(ctx, ["prService", "prPollingService"] as const);
    return ctx;
  };

  ipcMain.handle(IPC.prsCreateFromLane, async (_event, arg: CreatePrFromLaneArgs): Promise<PrSummary> => {
    const ctx = ensurePrMutationContext();
    const result = await ctx.prService.createFromLane(arg);
    ctx.prPollingService.poke();
    return result;
  });

  ipcMain.handle(IPC.prsLinkToLane, async (_event, arg: LinkPrToLaneArgs): Promise<PrSummary> => {
    const ctx = ensurePrMutationContext();
    const result = await ctx.prService.linkToLane(arg);
    ctx.prPollingService.poke();
    return result;
  });

  ipcMain.handle(IPC.prsPreflightCreateLaneFromPrBranch, async (_event, arg: CreateLaneFromPrBranchArgs): Promise<CreateLaneFromPrBranchPreflightResult> => {
    const ctx = ensurePrMutationContext();
    return await ctx.prService.preflightCreateLaneFromPrBranch(arg);
  });

  ipcMain.handle(IPC.prsCreateLaneFromPrBranch, async (_event, arg: CreateLaneFromPrBranchArgs): Promise<CreateLaneFromPrBranchResult> => {
    const ctx = ensurePrMutationContext();
    const result = await ctx.prService.createLaneFromPrBranch(arg);
    ctx.prPollingService.poke();
    return result;
  });

  const ensurePrPolling = (): AppContextWith<"prService" | "prPollingService"> | null => {
    const ctx = getCtx();
    if (!ctx.prPollingService || !ctx.prService) return null;
    requireAppContextServices(ctx, ["prService", "prPollingService"] as const);
    ctx.prPollingService.start();
    return ctx;
  };
  const ensurePrReadContext = (): AppContextWith<"prService" | "prPollingService"> => {
    const ctx = ensurePrPolling();
    if (!ctx) throw new Error("PR service is not available for this project window.");
    return ctx;
  };

  const ensurePrAiResolutionContext = (): AppContextWith<"agentChatService" | "conflictService" | "sessionService"> => {
    const ctx = getCtx();
    requireAppContextServices(ctx, ["agentChatService", "conflictService", "sessionService"] as const);
    return ctx;
  };

  ipcMain.handle(IPC.prsGetForLane, async (_event, arg: { laneId: string }): Promise<PrSummary | null> => {
    const ctx = ensurePrPolling();
    if (!ctx) return null;
    return ctx.prService.getForLane(arg.laneId);
  });

  ipcMain.handle(IPC.prsListAll, async (): Promise<PrSummary[]> => {
    const ctx = ensurePrReadContext();
    return ctx.prService.listAll();
  });

  ipcMain.handle(IPC.prsListOpenForRepo, async (): Promise<BranchPullRequest[]> => {
    const ctx = ensurePrReadContext();
    return await ctx.prService.listOpenPullRequests();
  });

  ipcMain.handle(IPC.prsRefresh, async (_event, arg: { prId?: string; prIds?: string[] } = {}): Promise<PrSummary[]> => {
    const ctx = ensurePrReadContext();
    return await ctx.prService.refresh(arg);
  });

  ipcMain.handle(IPC.prsGetStatus, async (_event, arg: { prId: string }): Promise<PrStatus | null> => {
    const ctx = ensurePrReadContext();
    try {
      return await ctx.prService.getStatus(arg.prId);
    } catch (err) {
      // Return null for stale/deleted PR IDs instead of crashing
      if (err instanceof Error && err.message.includes("PR not found")) return null;
      throw err;
    }
  });

  ipcMain.handle(IPC.prsGetChecks, async (_event, arg: { prId: string }): Promise<PrCheck[]> => {
    const ctx = ensurePrReadContext();
    try {
      return await ctx.prService.getChecks(arg.prId);
    } catch (err) {
      if (err instanceof Error && err.message.includes("PR not found")) return [];
      throw err;
    }
  });

  ipcMain.handle(IPC.prsGetComments, async (_event, arg: { prId: string }): Promise<PrComment[]> => {
    const ctx = ensurePrReadContext();
    try {
      return await ctx.prService.getComments(arg.prId);
    } catch (err) {
      if (err instanceof Error && err.message.includes("PR not found")) return [];
      throw err;
    }
  });

  ipcMain.handle(IPC.prsGetReviews, async (_event, arg: { prId: string }): Promise<PrReview[]> => {
    const ctx = ensurePrReadContext();
    try {
      return await ctx.prService.getReviews(arg.prId);
    } catch (err) {
      if (err instanceof Error && err.message.includes("PR not found")) return [];
      throw err;
    }
  });

  ipcMain.handle(IPC.prsGetReviewThreads, async (_event, arg: { prId: string }): Promise<PrReviewThread[]> => {
    const ctx = ensurePrReadContext();
    try {
      return await ctx.prService.getReviewThreads(arg.prId);
    } catch (err) {
      if (err instanceof Error && err.message.includes("PR not found")) return [];
      throw err;
    }
  });

  ipcMain.handle(IPC.prsUpdateDescription, async (_event, arg: UpdatePrDescriptionArgs): Promise<void> => {
    const ctx = ensurePrMutationContext();
    await ctx.prService.updateDescription(arg);
    ctx.prPollingService.poke();
  });

  ipcMain.handle(IPC.prsDelete, async (_event, arg: DeletePrArgs): Promise<DeletePrResult> => {
    const ctx = ensurePrMutationContext();
    const result = await ctx.prService.delete(arg);
    ctx.prPollingService.poke();
    return result;
  });

  ipcMain.handle(IPC.prsDraftDescription, async (_event, arg: DraftPrDescriptionArgs): Promise<{ title: string; body: string }> => {
    const ctx = ensurePrReadContext();
    return await ctx.prService.draftDescription(arg);
  });

  ipcMain.handle(IPC.prsLand, async (_event, arg: LandPrArgs): Promise<LandResult> => {
    const ctx = ensurePrMutationContext();
    const result = await ctx.prService.land(arg);
    ctx.prPollingService.poke();
    return result;
  });

  ipcMain.handle(IPC.prsUpdateBranch, async (_event, arg: UpdateBranchArgs): Promise<UpdateBranchResult> => {
    const ctx = ensurePrMutationContext();
    const result = await ctx.prService.updateBranch(arg);
    ctx.prPollingService.poke();
    return result;
  });

  ipcMain.handle(IPC.prsLandStack, async (_event, arg: LandStackArgs): Promise<LandResult[]> => {
    const ctx = ensurePrMutationContext();
    const result = await ctx.prService.landStack(arg);
    ctx.prPollingService.poke();
    return result;
  });

  ipcMain.handle(IPC.prsRetargetBase, async (_event, arg: { prId: string; baseBranch: string }): Promise<void> => {
    const ctx = ensurePrMutationContext();
    await ctx.prService.retargetBase(arg.prId, arg.baseBranch);
    ctx.prPollingService.poke();
  });

  ipcMain.handle(IPC.prsOpenInGitHub, async (_event, arg: { prId: string }): Promise<void> => {
    const ctx = ensurePrReadContext();
    return await ctx.prService.openInGitHub(arg.prId);
  });

  ipcMain.handle(IPC.prsCreateIntegration, async (_event, arg: CreateIntegrationPrArgs): Promise<CreateIntegrationPrResult> => {
    const ctx = ensurePrMutationContext();
    const result = await ctx.prService.createIntegrationPr(arg);
    ctx.prPollingService.poke();
    return result;
  });

  ipcMain.handle(IPC.prsLandStackEnhanced, async (_event, arg: LandStackEnhancedArgs): Promise<LandResult[]> => {
    const ctx = ensurePrMutationContext();
    const result = await ctx.prService.landStackEnhanced(arg);
    ctx.prPollingService.poke();
    return result;
  });

  ipcMain.handle(IPC.prsGetConflictAnalysis, async (_event, arg: { prId: string }) => {
    const ctx = ensurePrReadContext();
    return ctx.prService.getConflictAnalysis(arg.prId);
  });

  ipcMain.handle(IPC.prsGetMergeContext, async (_event, arg: { prId: string }): Promise<PrMergeContext> => {
    const ctx = ensurePrReadContext();
    return ctx.prService.getMergeContext(arg.prId);
  });

  ipcMain.handle(IPC.prsGetMergeContexts, async (_event, arg: { prIds?: string[] }): Promise<Record<string, PrMergeContext>> => {
    const ctx = ensurePrReadContext();
    return ctx.prService.getMergeContexts(Array.isArray(arg?.prIds) ? arg.prIds : []);
  });

  ipcMain.handle(IPC.prsListWithConflicts, async (_event, arg?: { includeConflictAnalysis?: boolean }) => {
    const ctx = ensurePrReadContext();
    return ctx.prService.listWithConflicts({
      includeConflictAnalysis: arg?.includeConflictAnalysis === true,
    });
  });

  ipcMain.handle(IPC.prsListSnapshots, async (_event, arg?: { prId?: string }) => {
    const ctx = ensurePrReadContext();
    return ctx.prService.listSnapshots({ prId: typeof arg?.prId === "string" ? arg.prId : undefined });
  });

  ipcMain.handle(IPC.prsGetGitHubSnapshot, async (_event, arg?: { force?: boolean; includeExternalClosed?: boolean; historyPageLimit?: number }): Promise<GitHubPrSnapshot> => {
    const ctx = ensurePrReadContext();
    return await ctx.prService.getGithubSnapshot({
      force: arg?.force === true,
      includeExternalClosed: arg?.includeExternalClosed === true,
      historyPageLimit: typeof arg?.historyPageLimit === "number" ? arg.historyPageLimit : undefined,
    });
  });

  ipcMain.handle(IPC.prsCreateQueue, async (_event, arg: CreateQueuePrsArgs): Promise<CreateQueuePrsResult> => {
    const ctx = ensurePrMutationContext();
    const result = await ctx.prService.createQueuePrs(arg);
    ctx.prPollingService.poke();
    return result;
  });

  ipcMain.handle(IPC.prsSimulateIntegration, async (_event, arg: SimulateIntegrationArgs): Promise<IntegrationProposal> =>
    ensurePrReadContext().prService.simulateIntegration(arg));

  ipcMain.handle(IPC.prsCommitIntegration, async (_event, arg: CommitIntegrationArgs): Promise<CreateIntegrationPrResult> => {
    const ctx = ensurePrMutationContext();
    const result = await ctx.prService.commitIntegration(arg);
    ctx.prPollingService.poke();
    return result;
  });

  ipcMain.handle(IPC.prsListProposals, async (): Promise<IntegrationProposal[]> =>
    await ensurePrReadContext().prService.listIntegrationProposals(),
  );

  ipcMain.handle(IPC.prsListIntegrationWorkflows, async (_event, arg: ListIntegrationWorkflowsArgs = {}): Promise<IntegrationProposal[]> =>
    await ensurePrReadContext().prService.listIntegrationWorkflows(arg),
  );

  ipcMain.handle(IPC.prsUpdateProposal, async (_event, arg: UpdateIntegrationProposalArgs): Promise<void> =>
    ensurePrReadContext().prService.updateIntegrationProposal(arg),
  );

  ipcMain.handle(IPC.prsDeleteProposal, async (_event, arg: DeleteIntegrationProposalArgs): Promise<DeleteIntegrationProposalResult> =>
    await ensurePrReadContext().prService.deleteIntegrationProposal(arg),
  );

  ipcMain.handle(IPC.prsDismissIntegrationCleanup, async (_event, arg: DismissIntegrationCleanupArgs): Promise<IntegrationProposal> =>
    await ensurePrReadContext().prService.dismissIntegrationCleanup(arg),
  );

  ipcMain.handle(IPC.prsCleanupIntegrationWorkflow, async (_event, arg: CleanupIntegrationWorkflowArgs): Promise<CleanupIntegrationWorkflowResult> =>
    await ensurePrReadContext().prService.cleanupIntegrationWorkflow(arg),
  );

  ipcMain.handle(IPC.prsLandQueueNext, async (_event, arg: LandQueueNextArgs): Promise<LandResult> => {
    const ctx = ensurePrMutationContext();
    const result = await ctx.prService.landQueueNext(arg);
    ctx.prPollingService.poke();
    return result;
  });

  ipcMain.handle(IPC.prsStartQueueAutomation, async (_event, arg) => {
    const ctx = getCtx();
    if (!ctx.queueLandingService) throw new Error("Queue automation is unavailable in this runtime.");
    return await ctx.queueLandingService.startQueue(arg);
  });

  ipcMain.handle(IPC.prsPauseQueueAutomation, async (_event, arg) => getCtx().queueLandingService?.pauseQueue(arg.queueId) ?? null);

  ipcMain.handle(IPC.prsResumeQueueAutomation, async (_event, arg) => {
    const ctx = getCtx();
    return ctx.queueLandingService?.resumeQueue(arg) ?? null;
  });

  ipcMain.handle(IPC.prsCancelQueueAutomation, async (_event, arg) => getCtx().queueLandingService?.cancelQueue(arg.queueId) ?? null);

  ipcMain.handle(IPC.prsReorderQueue, async (_event, arg: ReorderQueuePrsArgs): Promise<void> => {
    const ctx = ensurePrMutationContext();
    await ctx.prService.reorderQueuePrs(arg);
    ctx.prPollingService.poke();
  });

  ipcMain.handle(IPC.prsGetHealth, async (_event, arg: { prId: string }): Promise<PrHealth> => {
    const ctx = ensurePrReadContext();
    return ctx.prService.getPrHealth(arg.prId);
  });

  ipcMain.handle(IPC.prsGetQueueState, async (_event, arg: { groupId: string }): Promise<QueueLandingState | null> =>
    getCtx().queueLandingService?.getQueueStateByGroup(arg.groupId) ?? null
  );

  ipcMain.handle(IPC.prsListQueueStates, async (_event, arg = {}) => getCtx().queueLandingService?.listQueueStates(arg) ?? []);

  ipcMain.handle(IPC.prsCreateIntegrationLaneForProposal, async (_event, arg: CreateIntegrationLaneForProposalArgs): Promise<CreateIntegrationLaneForProposalResult> =>
    ensurePrReadContext().prService.createIntegrationLaneForProposal(arg));

  ipcMain.handle(IPC.prsStartIntegrationResolution, async (_event, arg: StartIntegrationResolutionArgs): Promise<StartIntegrationResolutionResult> =>
    ensurePrReadContext().prService.startIntegrationResolution(arg));

  ipcMain.handle(IPC.prsGetIntegrationResolutionState, async (_event, arg: { proposalId: string }): Promise<IntegrationResolutionState | null> =>
    ensurePrReadContext().prService.getIntegrationResolutionState(arg.proposalId));

  ipcMain.handle(IPC.prsRecheckIntegrationStep, async (_event, arg: RecheckIntegrationStepArgs): Promise<RecheckIntegrationStepResult> =>
    ensurePrReadContext().prService.recheckIntegrationStep(arg));

  ipcMain.handle(IPC.prsAiResolutionGetSession, async (_event, arg: PrAiResolutionGetSessionArgs): Promise<PrAiResolutionGetSessionResult> => {
    const ctx = ensurePrAiResolutionContext();
    const context = (arg?.context ?? {}) as PrAiResolutionContext;
    const contextKey = buildPrAiResolutionContextKey(context);
    const liveSessionId = prAiSessionsByContextKey.get(contextKey);
    const sessionSummaries = await ctx.agentChatService.listSessions();

    if (liveSessionId) {
      const runtime = prAiSessions.get(liveSessionId);
      if (runtime) {
        const summary = sessionSummaries.find((entry) => entry.sessionId === liveSessionId) ?? null;
        return buildPrAiSessionInfo({
          context: runtime.context,
          contextKey,
          sessionId: liveSessionId,
          provider: runtime.provider,
          model: summary?.model ?? runtime.modelId,
          modelId: summary?.modelId ?? runtime.modelId,
          reasoning: summary?.reasoningEffort ?? runtime.reasoning,
          permissionMode: deriveAiPermissionModeFromSummary(summary) ?? runtime.permissionMode,
          status: "running",
        });
      }
      prAiSessionsByContextKey.delete(contextKey);
    }

    const persistedRun = ctx.conflictService
      .listExternalResolverRuns({ limit: 200 })
      .find((entry) => entry.resolverContextKey === contextKey && entry.sessionId);
    if (!persistedRun?.sessionId) {
      return null;
    }

    const summary = sessionSummaries.find((entry) => entry.sessionId === persistedRun.sessionId) ?? null;
    return buildPrAiSessionInfo({
      context,
      contextKey,
      sessionId: persistedRun.sessionId,
      provider: persistedRun.provider,
      model: summary?.model ?? persistedRun.model ?? null,
      modelId: summary?.modelId ?? persistedRun.model ?? null,
      reasoning: summary?.reasoningEffort ?? persistedRun.reasoningEffort ?? null,
      permissionMode: deriveAiPermissionModeFromSummary(summary) ?? persistedRun.permissionMode ?? null,
      status: mapExternalResolverStatusToPrAi(persistedRun.status),
    });
  });

  ipcMain.handle(IPC.prsAiResolutionStart, async (_event, arg: PrAiResolutionStartArgs): Promise<PrAiResolutionStartResult> => {
    const ctx = ensurePrAiResolutionContext();
    const context = (arg?.context ?? {}) as PrAiResolutionContext;
    const model = typeof arg?.model === "string" ? arg.model.trim() : "";
    const targetLaneId = typeof context.targetLaneId === "string" ? context.targetLaneId.trim() : "";
    const sourceLaneIds = collectPrAiSourceLaneIds(context);
    const permissionMode: PrAgentPermissionMode = arg?.permissionMode ?? "default";
    const reasoning = typeof arg?.reasoning === "string" && arg.reasoning.trim().length > 0
      ? arg.reasoning.trim()
      : null;
    const additionalInstructions = typeof arg?.additionalInstructions === "string" && arg.additionalInstructions.trim().length > 0
      ? arg.additionalInstructions.trim()
      : null;
    let runId = "";

    if (!model) {
      const sessionId = randomUUID();
      const error = "Model is required to start AI resolution.";
      emitPrAiResolutionEvent({
        sessionId,
        status: "failed",
        message: error,
        timestamp: nowIso()
      });
      return { sessionId, provider: "codex", ptyId: null, status: "failed", error, context };
    }
    if (!targetLaneId) {
      const sessionId = randomUUID();
      const error = "Target lane is required to start AI resolution.";
      emitPrAiResolutionEvent({
        sessionId,
        status: "failed",
        message: error,
        timestamp: nowIso()
      });
      return { sessionId, provider: inferPrAiProvider(model), ptyId: null, status: "failed", error, context };
    }
    if (sourceLaneIds.length === 0) {
      const sessionId = randomUUID();
      const error = "At least one source lane is required to start AI resolution.";
      emitPrAiResolutionEvent({
        sessionId,
        status: "failed",
        message: error,
        timestamp: nowIso()
      });
      return { sessionId, provider: inferPrAiProvider(model), ptyId: null, status: "failed", error, context };
    }

    try {
      const provider = inferPrAiProvider(model);
      const modelDescriptor = getModelById(model);
      const prep = await ctx.conflictService.prepareResolverSession({
        provider,
        targetLaneId,
        sourceLaneIds,
        cwdLaneId: typeof context.integrationLaneId === "string" && context.integrationLaneId.trim().length > 0
          ? context.integrationLaneId.trim()
          : (typeof context.laneId === "string" && context.laneId.trim().length > 0
            ? context.laneId.trim()
            : undefined),
        proposalId: typeof context.proposalId === "string" && context.proposalId.trim().length > 0
          ? context.proposalId.trim()
          : undefined,
        sourceTab: context.sourceTab,
        scenario: context.scenario ?? (sourceLaneIds.length > 1 ? "integration-merge" : "single-merge"),
        model,
        reasoningEffort: reasoning,
        permissionMode,
        additionalInstructions,
        originSurface:
          context.sourceTab === "integration" ? "integration"
          : context.sourceTab === "rebase" ? "rebase"
          : "manual",
      });
      runId = prep.runId;
      if (prep.status === "blocked") {
        const sessionId = randomUUID();
        const reason = prep.contextGaps.length
          ? prep.contextGaps.map((gap) => gap.message).join(", ")
          : "Resolver session blocked due to insufficient context.";
        emitPrAiResolutionEvent({
          sessionId,
          status: "failed",
          message: reason,
          timestamp: nowIso()
        });
        return { sessionId, provider, ptyId: null, status: "failed", error: reason, context };
      }

      const session = await ctx.agentChatService.createSession({
        laneId: prep.cwdLaneId,
        provider,
        model: modelDescriptor?.shortId ?? model,
        ...(modelDescriptor?.id ? { modelId: modelDescriptor.id } : {}),
        ...(reasoning ? { reasoningEffort: reasoning } : {}),
        ...mapPrAiPermissionModeToNativeFields(permissionMode, provider),
      });
      const promptText = fs.readFileSync(prep.promptFilePath, "utf8");
      const runtimeContext: PrAiResolutionContext = {
        ...context,
        laneId: prep.cwdLaneId,
        targetLaneId,
        sourceLaneId: sourceLaneIds[0] ?? context.sourceLaneId ?? context.laneId ?? null,
        sourceLaneIds,
        integrationLaneId: prep.integrationLaneId ?? context.integrationLaneId ?? null,
      };
      const contextKey = buildPrAiResolutionContextKey(runtimeContext);

      const runtime: PrAiRuntimeSession = {
        sessionId: session.id,
        ptyId: null,
        runId: prep.runId,
        provider,
        contextKey,
        context: runtimeContext,
        modelId: model,
        reasoning,
        permissionMode,
        pollTimer: null,
        finalizing: false
      };
      await ctx.conflictService.attachResolverSession({
        runId: prep.runId,
        ptyId: null,
        sessionId: session.id,
        command: []
      });
      runtime.pollTimer = setInterval(() => {
        const current = prAiSessions.get(runtime.sessionId);
        if (!current || current.finalizing) return;
        const detail = getCtx().sessionService?.get(runtime.sessionId);
        if (!detail || detail.status === "running") return;
        void finalizePrAiSession(runtime.sessionId);
      }, 1_000);
      prAiSessions.set(runtime.sessionId, runtime);
      prAiSessionsByContextKey.set(contextKey, runtime.sessionId);
      emitPrAiResolutionEvent({
        sessionId: runtime.sessionId,
        status: "running",
        message: null,
        timestamp: nowIso()
      });
      void ctx.agentChatService.sendMessage({
        sessionId: runtime.sessionId,
        text: promptText,
        displayText: buildPrAiDisplayText(runtimeContext),
        ...(reasoning ? { reasoningEffort: reasoning } : {})
      }).catch(async (error: unknown) => {
        ctx.logger.warn("ipc.prs_ai_resolution_send_failed", {
          sessionId: runtime.sessionId,
          runId: prep.runId,
          error: getErrorMessage(error)
        });
        await finalizePrAiSession(runtime.sessionId, {
          forceStatus: "failed",
          message: getErrorMessage(error)
        });
      });
      return {
        sessionId: runtime.sessionId,
        provider,
        ptyId: null,
        status: "started",
        error: null,
        context: runtimeContext
      };
    } catch (error) {
      if (runId) {
        try {
          await ctx.conflictService.finalizeResolverSession({ runId, exitCode: 1 });
        } catch {
          // ignore finalize failures
        }
      }
      const sessionId = randomUUID();
      const message = getErrorMessage(error);
      emitPrAiResolutionEvent({
        sessionId,
        status: "failed",
        message,
        timestamp: nowIso()
      });
      return {
        sessionId,
        provider: inferPrAiProvider(model),
        ptyId: null,
        status: "failed",
        error: message,
        context
      };
    }
  });

  ipcMain.handle(IPC.prsAiResolutionInput, async (_event, arg: PrAiResolutionInputArgs): Promise<void> => {
    const sessionId = typeof arg?.sessionId === "string" ? arg.sessionId.trim() : "";
    const text = typeof arg?.text === "string" ? arg.text : "";
    if (!sessionId || !text.length) return;
    const runtime = prAiSessions.get(sessionId);
    if (!runtime) throw new Error(`AI resolution session not found: ${sessionId}`);
    const ctx = ensurePrAiResolutionContext();
    const sessionDetail = ctx.sessionService.get(sessionId);
    if (sessionDetail?.status === "running") {
      await ctx.agentChatService.steer({ sessionId, text });
      return;
    }
    await ctx.agentChatService.sendMessage({ sessionId, text });
  });

  ipcMain.handle(IPC.prsAiResolutionStop, async (_event, arg: PrAiResolutionStopArgs): Promise<void> => {
    const sessionId = typeof arg?.sessionId === "string" ? arg.sessionId.trim() : "";
    if (!sessionId) return;
    const runtime = prAiSessions.get(sessionId);
    if (!runtime) return;
    const ctx = ensurePrAiResolutionContext();
    await ctx.agentChatService.interrupt({ sessionId });
    await finalizePrAiSession(sessionId, {
      forceStatus: "cancelled",
      message: "AI resolution stopped by user."
    });
  });

  ipcMain.handle(IPC.prsGetDetail, (_e, args: { prId: string }) => {
    const ctx = ensurePrReadContext();
    return ctx.prService.getDetail(args.prId);
  });
  ipcMain.handle(IPC.prsGetFiles, (_e, args: { prId: string }) => {
    const ctx = ensurePrReadContext();
    return ctx.prService.getFiles(args.prId);
  });
  ipcMain.handle(IPC.prsGetCommits, (_e, args: { prId: string }): Promise<PrCommit[]> | PrCommit[] => {
    const ctx = ensurePrReadContext();
    return ctx.prService.getCommits(args.prId);
  });
  ipcMain.handle(IPC.prsGetActionRuns, (_e, args: { prId: string }) => {
    const ctx = ensurePrReadContext();
    return ctx.prService.getActionRuns(args.prId);
  });
  ipcMain.handle(IPC.prsGetActivity, (_e, args: { prId: string }) => {
    const ctx = ensurePrReadContext();
    return ctx.prService.getActivity(args.prId);
  });
  ipcMain.handle(IPC.prsGetDetailByGithub, (_e, coords: PrGithubCoords) => {
    return ensurePrReadContext().prService.getDetailByGithub(coords);
  });
  ipcMain.handle(IPC.prsGetFilesByGithub, (_e, coords: PrGithubCoords) => {
    return ensurePrReadContext().prService.getFilesByGithub(coords);
  });
  ipcMain.handle(IPC.prsGetCommitsByGithub, (_e, coords: PrGithubCoords): Promise<PrCommit[]> | PrCommit[] => {
    return ensurePrReadContext().prService.getCommitsByGithub(coords);
  });
  ipcMain.handle(IPC.prsGetActionRunsByGithub, (_e, coords: PrGithubCoords) => {
    return ensurePrReadContext().prService.getActionRunsByGithub(coords);
  });
  ipcMain.handle(IPC.prsGetActivityByGithub, (_e, coords: PrGithubCoords) => {
    return ensurePrReadContext().prService.getActivityByGithub(coords);
  });
  ipcMain.handle(IPC.prsGetStatusByGithub, async (_e, coords: PrGithubCoords): Promise<PrStatus | null> => {
    try {
      return await ensurePrReadContext().prService.getStatusByGithub(coords);
    } catch (err) {
      if (err instanceof Error && err.message.includes("PR not found")) return null;
      throw err;
    }
  });
  ipcMain.handle(IPC.prsGetChecksByGithub, async (_e, coords: PrGithubCoords): Promise<PrCheck[]> => {
    try {
      return await ensurePrReadContext().prService.getChecksByGithub(coords);
    } catch (err) {
      if (err instanceof Error && err.message.includes("PR not found")) return [];
      throw err;
    }
  });
  ipcMain.handle(IPC.prsGetReviewsByGithub, async (_e, coords: PrGithubCoords): Promise<PrReview[]> => {
    try {
      return await ensurePrReadContext().prService.getReviewsByGithub(coords);
    } catch (err) {
      if (err instanceof Error && err.message.includes("PR not found")) return [];
      throw err;
    }
  });
  ipcMain.handle(IPC.prsGetCommentsByGithub, async (_e, coords: PrGithubCoords): Promise<PrComment[]> => {
    try {
      return await ensurePrReadContext().prService.getCommentsByGithub(coords);
    } catch (err) {
      if (err instanceof Error && err.message.includes("PR not found")) return [];
      throw err;
    }
  });
  ipcMain.handle(IPC.prsGetReviewThreadsByGithub, async (_e, coords: PrGithubCoords): Promise<PrReviewThread[]> => {
    try {
      return await ensurePrReadContext().prService.getReviewThreadsByGithub(coords);
    } catch (err) {
      if (err instanceof Error && err.message.includes("PR not found")) return [];
      throw err;
    }
  });
  ipcMain.handle(IPC.prsAddComment, (_e, args) => ensurePrReadContext().prService.addComment(args));
  ipcMain.handle(IPC.prsUpdateComment, (_e, args) => ensurePrReadContext().prService.updateComment(args));
  ipcMain.handle(IPC.prsReplyToReviewThread, (_e, args: ReplyToPrReviewThreadArgs) => ensurePrReadContext().prService.replyToReviewThread(args));
  ipcMain.handle(IPC.prsResolveReviewThread, (_e, args: ResolvePrReviewThreadArgs) => ensurePrReadContext().prService.resolveReviewThread(args));
  ipcMain.handle(IPC.prsUpdateTitle, (_e, args) => ensurePrReadContext().prService.updateTitle(args));
  ipcMain.handle(IPC.prsUpdateBody, (_e, args) => ensurePrReadContext().prService.updateBody(args));
  ipcMain.handle(IPC.prsSetLabels, (_e, args) => ensurePrReadContext().prService.setLabels(args));
  ipcMain.handle(IPC.prsRequestReviewers, (_e, args) => ensurePrReadContext().prService.requestReviewers(args));
  ipcMain.handle(IPC.prsSubmitReview, (_e, args) => ensurePrReadContext().prService.submitReview(args));
  ipcMain.handle(IPC.prsClose, (_e, args) => ensurePrReadContext().prService.closePr(args));
  ipcMain.handle(IPC.prsReopen, (_e, args) => ensurePrReadContext().prService.reopenPr(args));
  ipcMain.handle(IPC.prsRerunChecks, (_e, args) => ensurePrReadContext().prService.rerunChecks(args));
  ipcMain.handle(IPC.prsAiReviewSummary, (_e, args) => ensurePrReadContext().prService.aiReviewSummary(args));

  // PRs Tab redesign (Timeline + Rails)
  ipcMain.handle(IPC.prsGetDeployments, (_e, args: { prId: string }) => {
    const ctx = ensurePrReadContext();
    return ctx.prService.getDeployments(args.prId);
  });
  ipcMain.handle(IPC.prsGetAiSummary, (_e, args: { prId: string }) => getCtx().prSummaryService?.getSummary(args.prId) ?? null);
  ipcMain.handle(IPC.prsRegenerateAiSummary, (_e, args: { prId: string }) => {
    const service = getCtx().prSummaryService;
    if (!service) throw new Error("PR summary service is unavailable for this project window.");
    return service.regenerateSummary(args.prId);
  });
  ipcMain.handle(IPC.prsPostReviewComment, (_e, args: PostPrReviewCommentArgs) => ensurePrReadContext().prService.postReviewComment(args));
  ipcMain.handle(
    IPC.prsSetReviewThreadResolved,
    (_e, args: SetPrReviewThreadResolvedArgs) => ensurePrReadContext().prService.setReviewThreadResolved(args),
  );
  ipcMain.handle(IPC.prsReactToComment, (_e, args: ReactToPrCommentArgs) => ensurePrReadContext().prService.reactToComment(args));
  ipcMain.handle(IPC.prsCleanupBranch, (_e, args: CleanupPrBranchArgs): Promise<CleanupPrBranchResult> =>
    ensurePrReadContext().prService.cleanupBranch(args));

  ipcMain.handle(IPC.rebaseScanNeeds, async () => ensureConflictContext().conflictService.scanRebaseNeeds());

  ipcMain.handle(IPC.rebaseGetNeed, async (_event, arg) => ensureConflictContext().conflictService.getRebaseNeed(arg.laneId));

  ipcMain.handle(IPC.rebaseDismiss, async (_event, arg) => ensureConflictContext().conflictService.dismissRebase(arg.laneId));

  ipcMain.handle(IPC.rebaseDefer, async (_event, arg) => ensureConflictContext().conflictService.deferRebase(arg.laneId, arg.until));

  ipcMain.handle(IPC.rebaseExecute, async (_event, arg) => ensureConflictContext().conflictService.rebaseLane(arg));

  const ensureOperationContext = (): AppContextWith<"operationService"> => {
    const ctx = getCtx();
    requireAppContextServices(ctx, ["operationService"] as const);
    return ctx;
  };

  ipcMain.handle(IPC.historyListOperations, async (_event, arg: ListOperationsArgs = {}): Promise<OperationRecord[]> => {
    const ctx = ensureOperationContext();
    return ctx.operationService.list(arg);
  });

  type HistoryExportIpcArgs = ExportHistoryArgs & {
    rows?: OperationRecord[];
    project?: {
      rootPath?: string | null;
      displayName?: string | null;
    } | null;
  };

  ipcMain.handle(IPC.historyExportOperations, async (event, arg: HistoryExportIpcArgs): Promise<ExportHistoryResult> => {
    const ctx = ensureOperationContext();
    const format: "csv" | "json" = arg?.format === "csv" ? "csv" : "json";
    const laneId = typeof arg?.laneId === "string" && arg.laneId.trim().length > 0 ? arg.laneId.trim() : undefined;
    const kind = typeof arg?.kind === "string" && arg.kind.trim().length > 0 ? arg.kind.trim() : undefined;
    const status = arg?.status;

    const rows = Array.isArray(arg?.rows)
      ? arg.rows
      : ctx.operationService.list({
          laneId,
          kind,
          ...(status && status !== "all" ? { status } : {}),
          limit: typeof arg?.limit === "number" ? arg.limit : 1000
        });
    const filteredRows =
      status && status !== "all"
        ? rows.filter((row) => row.status === status)
        : rows;

    const exportedAt = nowIso();
    const exportProject = arg?.project;
    const projectDisplayName =
      typeof exportProject?.displayName === "string" && exportProject.displayName.trim()
        ? exportProject.displayName.trim()
        : ctx.project.displayName;
    const projectRoot =
      typeof exportProject?.rootPath === "string" && exportProject.rootPath.trim()
        ? exportProject.rootPath.trim()
        : ctx.project.rootPath;
    const projectSlug = projectDisplayName.replace(/[^a-zA-Z0-9._-]+/g, "_");
    const dateStamp = exportedAt.slice(0, 10);
    const defaultDir = fs.existsSync(projectRoot) ? projectRoot : app.getPath("documents");
    const defaultPath = path.join(defaultDir, `ade-history-${projectSlug}-${dateStamp}.${format}`);

    const win = BrowserWindow.fromWebContents(event.sender) ?? undefined;
    const result = win
      ? await dialog.showSaveDialog(win, {
          title: "Export history",
          defaultPath,
          buttonLabel: "Export",
          filters:
            format === "csv"
              ? [{ name: "CSV", extensions: ["csv"] }]
              : [{ name: "JSON", extensions: ["json"] }]
        })
      : await dialog.showSaveDialog({
          title: "Export history",
          defaultPath,
          buttonLabel: "Export",
          filters:
            format === "csv"
              ? [{ name: "CSV", extensions: ["csv"] }]
              : [{ name: "JSON", extensions: ["json"] }]
        });

    if (result.canceled || !result.filePath) {
      return { cancelled: true };
    }

    let content = "";
    if (format === "json") {
      content = `${JSON.stringify(
        {
          exportedAt,
          project: {
            rootPath: projectRoot,
            displayName: projectDisplayName
          },
          filters: {
            laneId: laneId ?? null,
            kind: kind ?? null,
            status: status ?? "all"
          },
          rowCount: filteredRows.length,
          rows: filteredRows
        },
        null,
        2
      )}\n`;
    } else {
      const headers = [
        "id",
        "laneId",
        "laneName",
        "kind",
        "status",
        "startedAt",
        "endedAt",
        "preHeadSha",
        "postHeadSha",
        "metadataJson"
      ];
      const lines = [headers.join(",")];
      for (const row of filteredRows) {
        lines.push(
          [
            row.id,
            row.laneId,
            row.laneName,
            row.kind,
            row.status,
            row.startedAt,
            row.endedAt,
            row.preHeadSha,
            row.postHeadSha,
            row.metadataJson
          ]
            .map((value) => escapeCsvCell(value == null ? "" : String(value)))
            .join(",")
        );
      }
      content = `${lines.join("\n")}\n`;
    }

    fs.writeFileSync(result.filePath, content, "utf8");
    return {
      cancelled: false,
      savedPath: result.filePath,
      bytesWritten: Buffer.byteLength(content, "utf8"),
      exportedAt,
      rowCount: filteredRows.length,
      format
    };
  });

  ipcMain.handle(IPC.processesListDefinitions, async (): Promise<ProcessDefinition[]> => {
    const ctx = getCtx();
    requireAppContextServices(ctx, ["processService"] as const);
    return ctx.processService.listDefinitions();
  });

  ipcMain.handle(IPC.processesListRuntime, async (_event, arg: { laneId: string }): Promise<ProcessRuntime[]> => {
    const ctx = getCtx();
    requireAppContextServices(ctx, ["processService"] as const);
    if (!arg?.laneId) return [];
    return ctx.processService.listRuntime(arg.laneId);
  });

  ipcMain.handle(IPC.processesStart, async (_event, arg: ProcessActionArgs): Promise<ProcessRuntime> => {
    const ctx = getCtx();
    requireAppContextServices(ctx, ["processService"] as const);
    return await ctx.processService.start(arg);
  });

  ipcMain.handle(IPC.processesStop, async (_event, arg: ProcessActionArgs): Promise<ProcessRuntime | null> => {
    const ctx = getCtx();
    requireAppContextServices(ctx, ["processService"] as const);
    return await ctx.processService.stop(arg);
  });

  ipcMain.handle(IPC.processesRestart, async (_event, arg: ProcessActionArgs): Promise<ProcessRuntime> => {
    const ctx = getCtx();
    requireAppContextServices(ctx, ["processService"] as const);
    return await ctx.processService.restart(arg);
  });

  ipcMain.handle(IPC.processesKill, async (_event, arg: ProcessActionArgs): Promise<ProcessRuntime | null> => {
    const ctx = getCtx();
    requireAppContextServices(ctx, ["processService"] as const);
    return await ctx.processService.kill(arg);
  });

  ipcMain.handle(IPC.processesStartStack, async (_event, arg: ProcessStackArgs): Promise<void> => {
    const ctx = getCtx();
    requireAppContextServices(ctx, ["processService"] as const);
    await ctx.processService.startStack(arg);
  });

  ipcMain.handle(IPC.processesStopStack, async (_event, arg: ProcessStackArgs): Promise<void> => {
    const ctx = getCtx();
    requireAppContextServices(ctx, ["processService"] as const);
    await ctx.processService.stopStack(arg);
  });

  ipcMain.handle(IPC.processesRestartStack, async (_event, arg: ProcessStackArgs): Promise<void> => {
    const ctx = getCtx();
    requireAppContextServices(ctx, ["processService"] as const);
    await ctx.processService.restartStack(arg);
  });

  ipcMain.handle(IPC.processesStartGroup, async (_event, arg: ProcessGroupArgs): Promise<void> => {
    const ctx = getCtx();
    requireAppContextServices(ctx, ["processService"] as const);
    await ctx.processService.startGroup(arg);
  });

  ipcMain.handle(IPC.processesStopGroup, async (_event, arg: ProcessGroupArgs): Promise<void> => {
    const ctx = getCtx();
    requireAppContextServices(ctx, ["processService"] as const);
    await ctx.processService.stopGroup(arg);
  });

  ipcMain.handle(IPC.processesRestartGroup, async (_event, arg: ProcessGroupArgs): Promise<void> => {
    const ctx = getCtx();
    requireAppContextServices(ctx, ["processService"] as const);
    await ctx.processService.restartGroup(arg);
  });

  ipcMain.handle(IPC.processesStartAll, async (_event, arg: { laneId: string }): Promise<void> => {
    const ctx = getCtx();
    requireAppContextServices(ctx, ["processService"] as const);
    if (!arg?.laneId) return;
    await ctx.processService.startAll(arg);
  });

  ipcMain.handle(IPC.processesStopAll, async (_event, arg: { laneId: string }): Promise<void> => {
    const ctx = getCtx();
    requireAppContextServices(ctx, ["processService"] as const);
    if (!arg?.laneId) return;
    await ctx.processService.stopAll(arg);
  });

  ipcMain.handle(IPC.processesGetLogTail, async (_event, arg: GetProcessLogTailArgs): Promise<string> => {
    const ctx = getCtx();
    requireAppContextServices(ctx, ["processService"] as const);
    return ctx.processService.getLogTail(arg);
  });

  ipcMain.handle(IPC.testsListSuites, async (): Promise<TestSuiteDefinition[]> => {
    const ctx = getCtx();
    requireAppContextServices(ctx, ["testService"] as const);
    return ctx.testService.listSuites();
  });

  ipcMain.handle(IPC.testsRun, async (_event, arg: RunTestSuiteArgs): Promise<TestRunSummary> => {
    const ctx = getCtx();
    requireAppContextServices(ctx, ["testService"] as const);
    return ctx.testService.run(arg);
  });

  ipcMain.handle(IPC.testsStop, async (_event, arg: StopTestRunArgs): Promise<void> => {
    const ctx = getCtx();
    requireAppContextServices(ctx, ["testService"] as const);
    ctx.testService.stop(arg);
  });

  ipcMain.handle(IPC.testsListRuns, async (_event, arg: ListTestRunsArgs = {}): Promise<TestRunSummary[]> => {
    const ctx = getCtx();
    requireAppContextServices(ctx, ["testService"] as const);
    return ctx.testService.listRuns(arg);
  });

  ipcMain.handle(IPC.testsGetLogTail, async (_event, arg: GetTestLogTailArgs): Promise<string> => {
    const ctx = getCtx();
    requireAppContextServices(ctx, ["testService"] as const);
    return ctx.testService.getLogTail(arg);
  });

  ipcMain.handle(IPC.projectConfigGet, async (): Promise<ProjectConfigSnapshot> => {
    const ctx = getCtx();
    requireAppContextServices(ctx, ["projectConfigService"] as const);
    return ctx.projectConfigService.get();
  });

  ipcMain.handle(IPC.projectConfigValidate, async (_event, arg: { candidate: ProjectConfigCandidate }): Promise<ProjectConfigValidationResult> => {
    const ctx = getCtx();
    requireAppContextServices(ctx, ["projectConfigService"] as const);
    return ctx.projectConfigService.validate(arg.candidate);
  });

  ipcMain.handle(IPC.projectConfigSave, async (_event, arg: { candidate: ProjectConfigCandidate }): Promise<ProjectConfigSnapshot> => {
    const ctx = getCtx();
    requireAppContextServices(ctx, ["projectConfigService"] as const);
    const next = ctx.projectConfigService.save(arg.candidate);
    try {
      ctx.automationService?.syncFromConfig();
    } catch {
      // ignore schedule refresh failures
    }
    return next;
  });

  ipcMain.handle(IPC.projectConfigDiffAgainstDisk, async (): Promise<ProjectConfigDiff> => {
    const ctx = getCtx();
    requireAppContextServices(ctx, ["projectConfigService"] as const);
    return ctx.projectConfigService.diffAgainstDisk();
  });

  ipcMain.handle(IPC.projectConfigConfirmTrust, async (_event, arg: { sharedHash?: string } = {}): Promise<ProjectConfigTrust> => {
    const ctx = getCtx();
    requireAppContextServices(ctx, ["projectConfigService"] as const);
    return ctx.projectConfigService.confirmTrust(arg);
  });

  // ── CTO state IPC ─────────────────────────────────────────────────

  ipcMain.handle(IPC.ctoGetState, async (_event, arg: CtoGetStateArgs = {}): Promise<CtoSnapshot> => {
    const ctx = getCtx();
    if (!ctx.ctoStateService) {
      throw new Error("CTO state service is not available.");
    }
    return ctx.ctoStateService.getSnapshot(arg.recentLimit ?? 20);
  });

  ipcMain.handle(IPC.ctoEnsureSession, async (_event, arg: CtoEnsureSessionArgs = {}): Promise<AgentChatSession> => {
    const ctx = getCtx();
    requireAppContextServices(ctx, ["agentChatService"] as const);
    const laneId = await resolvePrimaryLaneIdOnly(ctx);
    if (!laneId) {
      throw new Error("No primary lane is available to host the CTO chat session.");
    }
    return ctx.agentChatService.ensureIdentitySession({
      identityKey: "cto",
      laneId,
      modelId: arg.modelId ?? null,
      reasoningEffort: arg.reasoningEffort ?? null,
      permissionMode: "full-auto",
    });
  });

  ipcMain.handle(IPC.ctoListSessionLogs, async (_event, arg: CtoListSessionLogsArgs = {}): Promise<CtoSessionLogEntry[]> => {
    const ctx = getCtx();
    if (!ctx.ctoStateService) {
      throw new Error("CTO state service is not available.");
    }
    return ctx.ctoStateService.getSessionLogs(arg.limit ?? 40);
  });

  ipcMain.handle(IPC.ctoUpdateIdentity, async (_event, arg: CtoUpdateIdentityArgs): Promise<CtoSnapshot> => {
    const ctx = getCtx();
    if (!ctx.ctoStateService) throw new Error("CTO state service is not available.");
    return ctx.ctoStateService.updateIdentity(arg.patch ?? {});
  });

  // -- Smart memory --

  ipcMain.handle(IPC.ctoGetMemory, async (_event, _arg: CtoGetMemoryArgs = {}): Promise<CtoMemorySnapshot> => {
    const ctx = getCtx();
    if (!ctx.ctoMemoryService) throw new Error("CTO memory service is not available.");
    return ctx.ctoMemoryService.getSnapshot();
  });

  ipcMain.handle(IPC.ctoUpdateMemory, async (_event, arg: CtoUpdateMemoryArgs): Promise<CtoMemorySnapshot> => {
    const ctx = getCtx();
    if (!ctx.ctoMemoryService) throw new Error("CTO memory service is not available.");
    // Only an explicit string may rewrite MEMORY.md — a missing field must not
    // silently blank the durable memory file.
    if (typeof arg?.memory !== "string") {
      throw new Error("updateMemory requires a string `memory` field.");
    }
    ctx.ctoMemoryService.writeMemory(arg.memory);
    return ctx.ctoMemoryService.getSnapshot();
  });

  ipcMain.handle(IPC.ctoSearchMemory, async (_event, arg: CtoSearchMemoryArgs): Promise<CtoSearchMemoryResult> => {
    const ctx = getCtx();
    if (!ctx.ctoMemoryService) throw new Error("CTO memory service is not available.");
    const query = arg?.query ?? "";
    const rows = ctx.ctoMemoryService.searchMemory(query, { limit: arg?.limit ?? 20 });
    return { query, rows };
  });

  // -- Linear connection & credentials --

  ipcMain.handle(IPC.ctoGetLinearConnectionStatus, async (): Promise<LinearConnectionStatus> => {
    const ctx = getCtx();
    const tokenStored = Boolean(ctx.linearCredentialService?.getStatus().tokenStored);
    return buildLinearConnectionStatus(ctx, tokenStored);
  });

  ipcMain.handle(IPC.ctoSetLinearToken, async (_event, arg: CtoSetLinearTokenArgs): Promise<LinearConnectionStatus> => {
    const ctx = getCtx();
    if (!ctx.linearCredentialService) throw new Error("Linear credential service is not available.");
    ctx.linearCredentialService.setToken(arg.token);
    const tokenStored = Boolean(ctx.linearCredentialService.getStatus().tokenStored);
    return buildLinearConnectionStatus(ctx, tokenStored);
  });

  ipcMain.handle(IPC.ctoClearLinearToken, async (): Promise<LinearConnectionStatus> => {
    const ctx = getCtx();
    if (!ctx.linearCredentialService) throw new Error("Linear credential service is not available.");
    ctx.linearCredentialService.clearToken();
    return {
      tokenStored: false,
      connected: false,
      viewerId: null,
      viewerName: null,
      checkedAt: nowIso(),
      authMode: null,
      oauthAvailable: ctx.linearCredentialService.getStatus().oauthConfigured,
      tokenExpiresAt: null,
      message: "Linear token cleared.",
    };
  });

  ipcMain.handle(IPC.ctoSetLinearOAuthClient, async (_event, arg: CtoSetLinearOAuthClientArgs): Promise<LinearConnectionStatus> => {
    const ctx = getCtx();
    if (!ctx.linearCredentialService) throw new Error("Linear credential service is not available.");
    ctx.linearCredentialService.setOAuthClientCredentials({
      clientId: arg.clientId,
      clientSecret: arg.clientSecret ?? null,
    });
    const tokenStored = Boolean(ctx.linearCredentialService.getStatus().tokenStored);
    return buildLinearConnectionStatus(ctx, tokenStored);
  });

  ipcMain.handle(IPC.ctoClearLinearOAuthClient, async (): Promise<LinearConnectionStatus> => {
    const ctx = getCtx();
    if (!ctx.linearCredentialService) throw new Error("Linear credential service is not available.");
    ctx.linearCredentialService.clearOAuthClientCredentials();
    const tokenStored = Boolean(ctx.linearCredentialService.getStatus().tokenStored);
    return buildLinearConnectionStatus(ctx, tokenStored);
  });

  ipcMain.handle(IPC.ctoStartLinearOAuth, async (): Promise<CtoStartLinearOAuthResult> => {
    const ctx = getCtx();
    return getLinearOAuthBridge(ctx).startSession();
  });

  ipcMain.handle(
    IPC.ctoGetLinearOAuthSession,
    async (_event, arg: CtoGetLinearOAuthSessionArgs): Promise<CtoGetLinearOAuthSessionResult> => {
      const ctx = getCtx();
      const session = getLinearOAuthBridge(ctx).getSession(arg.sessionId);
      if (session.status !== "completed") {
        return session;
      }
      const tokenStored = Boolean(ctx.linearCredentialService?.getStatus().tokenStored);
      return {
        ...session,
        connection: await buildLinearConnectionStatus(ctx, tokenStored),
      };
    }
  );

  // -- W-UX: Onboarding & Identity --

  ipcMain.handle(IPC.ctoGetOnboardingState, async () => {
    const ctx = getCtx();
    if (!ctx.ctoStateService) throw new Error("CTO state service is not available.");
    return ctx.ctoStateService.getOnboardingState();
  });

  ipcMain.handle(IPC.ctoCompleteOnboardingStep, async (_event, arg: { stepId: string }) => {
    const ctx = getCtx();
    if (!ctx.ctoStateService) throw new Error("CTO state service is not available.");
    return ctx.ctoStateService.completeOnboardingStep(arg.stepId);
  });

  ipcMain.handle(IPC.ctoDismissOnboarding, async () => {
    const ctx = getCtx();
    if (!ctx.ctoStateService) throw new Error("CTO state service is not available.");
    return ctx.ctoStateService.dismissOnboarding();
  });

  ipcMain.handle(IPC.ctoResetOnboarding, async () => {
    const ctx = getCtx();
    if (!ctx.ctoStateService) throw new Error("CTO state service is not available.");
    return ctx.ctoStateService.resetOnboarding();
  });

  ipcMain.handle(IPC.ctoPreviewSystemPrompt, async (_event, arg: { identityOverride?: Record<string, unknown> } = {}) => {
    const ctx = getCtx();
    if (!ctx.ctoStateService) throw new Error("CTO state service is not available.");
    return ctx.ctoStateService.previewSystemPrompt(arg.identityOverride as never);
  });

  ipcMain.handle(IPC.ctoGetLinearProjects, async () => {
    const ctx = getCtx();
    if (!ctx.linearIssueTracker) throw new Error("Linear issue tracker is not available.");
    try {
      const projects = await ctx.linearIssueTracker.listProjects();
      return projects;
    } catch {
      return [];
    }
  });

  ipcMain.handle(IPC.ctoGetLinearQuickView, async (): Promise<CtoLinearQuickView> => {
    const ctx = getCtx();
    const tokenStored = Boolean(ctx.linearCredentialService?.getStatus().tokenStored);
    const connection = await buildLinearConnectionStatus(ctx, tokenStored);
    if (!connection.connected || !ctx.linearIssueTracker) {
      return {
        connection,
        organization: null,
        viewer: null,
        projects: [],
        teams: [],
        assignedIssues: [],
        recentIssues: [],
        fetchedAt: nowIso(),
        sdk: {
          packageName: "@linear/sdk",
          surfaces: [],
        },
      };
    }
    return ctx.linearIssueTracker.getQuickView(connection);
  });

  ipcMain.handle(IPC.ctoGetLinearIssuePickerData, async (): Promise<CtoGetLinearIssuePickerDataResult> => {
    const ctx = getCtx();
    // When Linear is not configured, return an empty payload so the renderer
    // can render a graceful empty state instead of having to handle a thrown
    // error — matches the behavior the picker expects when Linear is offline.
    if (!ctx.linearIssueTracker) {
      return { projects: [], users: [], states: [] };
    }
    const [projects, users, states] = await Promise.all([
      ctx.linearIssueTracker.listProjects().catch(() => []),
      ctx.linearIssueTracker.listUsers().catch(() => []),
      ctx.linearIssueTracker.listWorkflowStates().catch(() => []),
    ]);
    return { projects, users, states };
  });

  ipcMain.handle(
    IPC.ctoSearchLinearIssues,
    async (_event, arg: CtoSearchLinearIssuesArgs = {}): Promise<CtoSearchLinearIssuesResult> => {
      const ctx = getCtx();
      if (!ctx.linearIssueTracker) {
        return { issues: [], pageInfo: { hasNextPage: false, endCursor: null } };
      }
      return ctx.linearIssueTracker.searchIssues(arg);
    }
  );

  ipcMain.handle(
    IPC.ctoGetLinearIssueComments,
    async (_event, arg: { issueId: string }): Promise<CtoLinearIssueComment[]> => {
      if (typeof arg?.issueId !== "string" || !arg.issueId.trim()) return [];
      const ctx = getCtx();
      if (!ctx.linearIssueTracker) return [];
      return ctx.linearIssueTracker.fetchIssueComments(arg.issueId);
    }
  );

  ipcMain.handle(IPC.ctoRunProjectScan, async (): Promise<CtoRunProjectScanResult> => {
    const ctx = getCtx();
    requireAppContextServices(ctx, ["onboardingService"] as const);
    const detection = await ctx.onboardingService.detectDefaults().catch(() => null);
    return { detection };
  });

  ipcMain.handle(IPC.updateCheckForUpdates, () => {
    getCtx().autoUpdateService?.checkForUpdates();
  });

  ipcMain.handle(IPC.updateGetState, () => {
    return getCtx().autoUpdateService?.getSnapshot() ?? createEmptyAutoUpdateSnapshot();
  });

  ipcMain.handle(IPC.updateGetInstallImpact, async (): Promise<UpdateInstallImpact> => {
    const provider = getCtx().updateInstallImpactProvider;
    if (!provider) return { connectedPhones: [] };
    try {
      return await provider();
    } catch {
      // Best-effort probe: a failed impact query must never block the update UI.
      return { connectedPhones: [] };
    }
  });

  ipcMain.handle(IPC.updateQuitAndInstall, () => {
    return getCtx().autoUpdateService?.quitAndInstall() ?? false;
  });

  ipcMain.handle(IPC.updateDismissInstalledNotice, () => {
    getCtx().autoUpdateService?.dismissInstalledNotice();
  });

}
