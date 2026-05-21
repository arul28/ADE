import { app, BrowserWindow, clipboard, desktopCapturer, dialog, ipcMain, nativeImage, shell } from "electron";
import type { IpcMainInvokeEvent } from "electron";
import { createEmptyAutoUpdateSnapshot, type createAutoUpdateService } from "../updates/autoUpdateService";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import type { Server as NetServer } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { IPC } from "../../../shared/ipc";
import { getModelById } from "../../../shared/modelRegistry";
import { appendEvent as perfAppend, isRunActive as isPerfRunActive } from "../perf/perfLog";
import { buildPrAiResolutionContextKey } from "../../../shared/types";
import { launchPrIssueResolutionChat, previewPrIssueResolutionPrompt } from "../prs/prIssueResolver";
import { launchRebaseResolutionChat } from "../prs/prRebaseResolver";
import { browseProjectDirectories } from "../projects/projectBrowserService";
import { getProjectDetail } from "../projects/projectDetailService";
import {
  removeProjectIconOverride,
  resolveProjectIcon,
  resolveProjectIconPath,
  setProjectIconOverrideFromSelection,
} from "../projects/projectIconResolver";
import { runGit } from "../git/git";
import type { AdeCleanupResult, AdeProjectSnapshot, IosSimulatorWindowState } from "../../../shared/types";
import { toRecentProjectSummary } from "../projects/recentProjectSummary";
import type {
  ApplyConflictProposalArgs,
  BatchAssessmentResult,
  AttachLaneArgs,
  AdoptAttachedLaneArgs,
  UnregisteredLaneCandidate,
  AppInfo,
  ClearLocalAdeDataArgs,
  ClearLocalAdeDataResult,
  ArchiveLaneArgs,
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
  ReviewLaunchContext,
  AppControlClickArgs,
  AppControlConnectArgs,
  AppControlInspectPointArgs,
  AppControlLaunchArgs,
  AppControlSnapshotArgs,
  AppControlStopArgs,
  AppControlTypeTextArgs,
  BuiltInBrowserAttachWebviewArgs,
  BuiltInBrowserBoundsArgs,
  BuiltInBrowserCreateTabArgs,
  BuiltInBrowserNavigateArgs,
  BuiltInBrowserOpenPanelArgs,
  BuiltInBrowserSelectPointArgs,
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
  ReviewListRunsArgs,
  ReviewRun,
  ReviewRunDetail,
  ReviewStartRunArgs,
  AdeActionRegistryEntry,
  AddMissionArtifactArgs,
  AddMissionInterventionArgs,
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
  GitPushArgs,
  GitUpstreamSyncStatus,
  GitRevertArgs,
  GitStashPushArgs,
  GitStashRefArgs,
  GitStashSummary,
  GitSyncArgs,
  GitHubRepoRef,
  GitHubStatus,
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
  PrIssueResolutionPromptPreviewArgs,
  PrIssueResolutionPromptPreviewResult,
  PrIssueResolutionStartArgs,
  PrIssueResolutionStartResult,
  IssueInventoryItem,
  IssueInventorySnapshot,
  ConvergenceRuntimeState,
  PrConvergenceStatePatch,
  ConvergenceStatus,
  PipelineSettings,
  RebaseResolutionStartArgs,
  RebaseResolutionStartResult,
  LinkPrToLaneArgs,
  LandResult,
  LandStackEnhancedArgs,
  LandQueueNextArgs,
  CleanupPrBranchArgs,
  CleanupPrBranchResult,
  PrCheck,
  PrCommit,
  PrComment,
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
  LaunchPrIssueResolutionFromThreadArgs,
  LaunchPrIssueResolutionFromThreadResult,
  SimulateIntegrationArgs,
  UpdatePrDescriptionArgs,
  LandPrArgs,
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
  AgentChatCodexOpenInCliArgs,
  AgentChatCodexOpenInCliResult,
  AgentChatClaudeSessionInfo,
  AgentChatClaudeSessionInfoArgs,
  AgentChatClaudeSessionListArgs,
  AgentChatClaudeSessionMessage,
  AgentChatClaudeSessionMessagesArgs,
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
  AgentChatDeleteArgs,
  AgentChatGetSummaryArgs,
  AgentChatEventHistorySnapshot,
  AgentChatHandoffArgs,
  AgentChatHandoffResult,
  AgentChatInterruptArgs,
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
  OnboardingStatus,
  OnboardingTourProgress,
  OnboardingTourVariant,
  LaneListSnapshot,
  LaneSummary,
  ListOperationsArgs,
  ListOverlapsArgs,
  ListLanesArgs,
  ListMissionsArgs,
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
  StackChainItem,
  StopTestRunArgs,
  TerminalSessionDetail,
  TerminalSessionSummary,
  UpdateSessionMetaArgs,
  UpdateMissionArgs,
  UpdateMissionStepArgs,
  TestRunSummary,
  TestSuiteDefinition,
  UpdateIntegrationProposalArgs,
  UpdateLaneAppearanceArgs,
  WriteTextAtomicArgs,
  MissionDetail,
  MissionIntervention,
  MissionArtifact,
  MissionStep,
  MissionSummary,
  PhaseCard,
  PhaseProfile,
  ListPhaseItemsArgs,
  SavePhaseItemArgs,
  DeletePhaseItemArgs,
  ExportPhaseItemsArgs,
  ExportPhaseItemsResult,
  ImportPhaseItemsArgs,
  ListPhaseProfilesArgs,
  SavePhaseProfileArgs,
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
  ResolveMissionInterventionArgs,
  CreateMissionArgs,
  ArchiveMissionArgs,
  DeleteMissionArgs,
  CancelOrchestratorRunArgs,
  CleanupOrchestratorTeamResourcesArgs,
  CleanupOrchestratorTeamResourcesResult,
  CompleteOrchestratorAttemptArgs,
  GetOrchestratorGateReportArgs,
  GetOrchestratorRunGraphArgs,
  HeartbeatOrchestratorClaimsArgs,
  ListOrchestratorRunsArgs,
  ListOrchestratorTimelineArgs,
  OrchestratorAttempt,
  OrchestratorExecutorKind,
  OrchestratorGateReport,
  OrchestratorRun,
  OrchestratorRunGraph,
  OrchestratorStep,
  OrchestratorTimelineEvent,
  PauseOrchestratorRunArgs,
  ResumeOrchestratorRunArgs,
  StartOrchestratorAttemptArgs,
  StartOrchestratorRunFromMissionArgs,
  StartOrchestratorRunArgs,
  TickOrchestratorRunArgs,
  AiFeatureKey,
  AiApiKeyVerificationResult,
  AiConfig,
  AiSettingsStatus,
  OpenCodeRuntimeSnapshot,
  SyncDesktopConnectionDraft,
  SyncDeviceRecord,
  SyncDeviceRuntimeState,
  SyncGetStatusArgs,
  SyncPeerDeviceType,
  SyncRoleSnapshot,
  SyncTransferReadiness,
  ApnsBridgeStatus,
  ApnsBridgeSaveConfigArgs,
  ApnsBridgeUploadKeyArgs,
  ApnsBridgeSendTestPushArgs,
  ApnsBridgeSendTestPushResult,
  ApnsTestPushKind,
  CtoGetStateArgs,
  CtoEnsureSessionArgs,
  CtoUpdateIdentityArgs,
  CtoListSessionLogsArgs,
  CtoSnapshot,
  CtoSessionLogEntry,
  GetOrchestratorWorkerStatesArgs,
  OrchestratorWorkerState,
  StartMissionRunWithAIArgs,
  StartMissionRunWithAIResult,
  SteerMissionArgs,
  SteerMissionResult,
  GetModelCapabilitiesResult,
  GetTeamMembersArgs,
  GetTeamRuntimeStateArgs,
  FinalizeRunArgs,
  FinalizeRunResult,
  OrchestratorTeamMember,
  OrchestratorTeamRuntimeState,
  GetMissionMetricsArgs,
  GetOrchestratorContextCheckpointArgs,
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
  GetMissionLogsArgs,
  GetMissionLogsResult,
  ExportMissionLogsArgs,
  ExportMissionLogsResult,
  GetMissionBudgetTelemetryArgs,
  GetMissionBudgetStatusArgs,
  MissionBudgetSnapshot,
  MissionBudgetTelemetrySnapshot,
  SendAgentMessageArgs,
  GetGlobalChatArgs,
  DeliverMessageArgs,
  GetActiveAgentsArgs,
  ActiveAgentInfo,
  AgentIdentity,
  AgentSessionLogEntry,
  AgentConfigRevision,
  AgentBudgetSnapshot,
  WorkerAgentRun,
  AgentTaskSession,
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
  CtoListAgentSessionLogsArgs,
  CtoListAgentTaskSessionsArgs,
  CtoClearAgentTaskSessionArgs,
  CtoGetLinearOAuthSessionArgs,
  CtoGetLinearOAuthSessionResult,
  CtoGetLinearIssuePickerDataResult,
  CtoLinearQuickView,
  CtoSearchLinearIssuesArgs,
  CtoSearchLinearIssuesResult,
  CtoRunProjectScanResult,
  CtoStartLinearOAuthResult,
  LinearConnectionStatus,
  CtoSetLinearTokenArgs,
  CtoSetLinearOAuthClientArgs,
  CtoFlowPolicyRevision,
  CtoSaveFlowPolicyArgs,
  CtoRollbackFlowPolicyRevisionArgs,
  CtoSimulateFlowRouteArgs,
  CtoEnsureLinearWebhookArgs,
  CtoListLinearIngressEventsArgs,
  LinearRouteDecision,
  LinearWorkflowCatalog,
  LinearIngressEventRecord,
  LinearIngressStatus,
  LinearSyncDashboard,
  LinearSyncQueueItem,
  CtoResolveLinearSyncQueueItemArgs,
  CtoGetLinearWorkflowRunDetailArgs,
  LinearWorkflowRunDetail,
  LinearWorkflowConfig,
  NormalizedLinearIssue,
  UsageSnapshot,
  BudgetCheckResult,
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
  CursorCloudStreamRunRequest,
  CursorCloudStreamRunResult,
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
import type { createAiIntegrationService } from "../ai/aiIntegrationService";
import type { createGithubService } from "../github/githubService";
import type { createPrService } from "../prs/prService";
import type { createPrPollingService } from "../prs/prPollingService";
import type { createQueueLandingService } from "../prs/queueLandingService";
import type { createIssueInventoryService } from "../prs/issueInventoryService";
import type { PathToMergeOrchestrator } from "../prs/pathToMergeOrchestrator";
import type { createPrSummaryService } from "../prs/prSummaryService";
import type { createReviewService } from "../review/reviewService";
import type { createAgentChatService } from "../chat/agentChatService";
import type { createComputerUseArtifactBrokerService } from "../computerUse/computerUseArtifactBrokerService";
import { buildComputerUseOwnerSnapshot } from "../computerUse/controlPlane";
import type { createIosSimulatorService } from "../ios/iosSimulatorService";
import type { createAppControlService } from "../appControl/appControlService";
import type { createBuiltInBrowserService } from "../builtInBrowser/builtInBrowserService";
import type { createMacosVmService } from "../macosVm/macosVmService";
import { ipcInvokeTimeoutMs } from "./ipcTimeouts";
import { readGlobalState, writeGlobalState, reorderRecentProjects } from "../state/globalState";
import type { createKeybindingsService } from "../keybindings/keybindingsService";
import type { createAgentToolsService } from "../agentTools/agentToolsService";
import type { createDevToolsService } from "../devTools/devToolsService";
import type { createOnboardingService } from "../onboarding/onboardingService";
import type { DevToolsCheckResult } from "../../../shared/types/devTools";
import type { createAutomationService } from "../automations/automationService";
import type { createAutomationPlannerService } from "../automations/automationPlannerService";
import type { createAutomationIngressService } from "../automations/automationIngressService";
import type { createGithubPollingService } from "../automations/githubPollingService";
import { ADE_ACTION_ALLOWLIST, getAdeActionDomainServices, listAllowedAdeActionNames } from "../adeActions/registry";
import type { AdeRuntime } from "../../../../../ade-cli/src/bootstrap";
import { type createMissionService } from "../missions/missionService";
import type { createMissionPreflightService } from "../missions/missionPreflightService";

import type { createMissionBudgetService } from "../orchestrator/missionBudgetService";
import type { createOrchestratorService } from "../orchestrator/orchestratorService";
import type { createAiOrchestratorService } from "../orchestrator/aiOrchestratorService";
import { readCoordinatorCheckpoint } from "../orchestrator/missionStateDoc";
import type { createCtoStateService } from "../cto/ctoStateService";
import type { createWorkerAgentService } from "../cto/workerAgentService";
import type { createWorkerRevisionService } from "../cto/workerRevisionService";
import type { createWorkerBudgetService } from "../cto/workerBudgetService";
import type { createWorkerHeartbeatService } from "../cto/workerHeartbeatService";
import type { createWorkerTaskSessionService } from "../cto/workerTaskSessionService";
import type { createLinearCredentialService } from "../cto/linearCredentialService";
import { createLinearOAuthService, type LinearOAuthService } from "../cto/linearOAuthService";
import type { LocalRuntimeConnectionPool } from "../localRuntime/localRuntimeConnectionPool";
import { registerRuntimeBridge } from "./runtimeBridge";
import type { createFlowPolicyService } from "../cto/flowPolicyService";
import type { createLinearRoutingService } from "../cto/linearRoutingService";
import type { createLinearIngressService } from "../cto/linearIngressService";
import type { createLinearSyncService } from "../cto/linearSyncService";
import type { createLinearIssueTracker } from "../cto/linearIssueTracker";
import type { createUsageTrackingService } from "../usage/usageTrackingService";
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
import { resolveCodexExecutable } from "../ai/codexExecutable";
import {
  buildResumeArgv,
  detectCodexResumeStrategy,
  spawnInNewTerminalWindow,
} from "../chat/codexCliLauncher";
import { sanitizeResumeTargetId } from "../../utils/terminalSessionSignals";
import { probeLocalhostPort } from "../probeLocalhostPort";
import type { ProcessRegistryService } from "../runtime/processRegistryService";
import { deleteMacosVmFromProjectState } from "../macosVm/macosVmRecovery";

export type AppContext = {
  db: AdeDb;
  logger: Logger;
  project: ProjectInfo;
  hasUserSelectedProject: boolean;
  projectId: string;
  adeDir: string;
  getActiveRpcConnectionCount?: (() => number) | null;
  disposeHeadWatcher: () => void;
  keybindingsService: ReturnType<typeof createKeybindingsService>;
  agentToolsService: ReturnType<typeof createAgentToolsService>;
  adeCliService: ReturnType<typeof createAdeCliService>;
  devToolsService: ReturnType<typeof createDevToolsService> | null;
  onboardingService: ReturnType<typeof createOnboardingService>;
  laneService: ReturnType<typeof createLaneService>;
  laneWorktreeLockService?: LaneWorktreeLockService | null;
  laneEnvironmentService: ReturnType<typeof createLaneEnvironmentService> | null;
  laneTemplateService: ReturnType<typeof createLaneTemplateService> | null;
  portAllocationService: ReturnType<typeof createPortAllocationService> | null;
  laneProxyService: ReturnType<typeof createLaneProxyService> | null;
  oauthRedirectService: ReturnType<typeof createOAuthRedirectService> | null;
  runtimeDiagnosticsService: ReturnType<typeof createRuntimeDiagnosticsService> | null;
  rebaseSuggestionService: ReturnType<typeof createRebaseSuggestionService> | null;
  autoRebaseService: ReturnType<typeof createAutoRebaseService> | null;
  sessionService: ReturnType<typeof createSessionService>;
  processRegistry?: ProcessRegistryService | null;
  ptyService: ReturnType<typeof createPtyService>;
  diffService: ReturnType<typeof createDiffService>;
  fileService: ReturnType<typeof createFileService>;
  operationService: ReturnType<typeof createOperationService>;
  gitService: ReturnType<typeof createGitOperationsService>;
  conflictService: ReturnType<typeof createConflictService>;
  aiIntegrationService: ReturnType<typeof createAiIntegrationService>;
  agentChatService: ReturnType<typeof createAgentChatService>;
  computerUseArtifactBrokerService: ReturnType<typeof createComputerUseArtifactBrokerService>;
  iosSimulatorService?: ReturnType<typeof createIosSimulatorService> | null;
  appControlService?: ReturnType<typeof createAppControlService> | null;
  builtInBrowserService?: ReturnType<typeof createBuiltInBrowserService> | null;
  macosVmService?: ReturnType<typeof createMacosVmService> | null;
  githubService: ReturnType<typeof createGithubService>;
  projectScaffoldService: ReturnType<typeof createProjectScaffoldService>;
  prService: ReturnType<typeof createPrService>;
  prPollingService: ReturnType<typeof createPrPollingService>;
  queueLandingService: ReturnType<typeof createQueueLandingService>;
  issueInventoryService: ReturnType<typeof createIssueInventoryService>;
  pathToMergeOrchestrator?: PathToMergeOrchestrator | null;
  prSummaryService: ReturnType<typeof createPrSummaryService>;
  reviewService: ReturnType<typeof createReviewService>;
  jobEngine: ReturnType<typeof createJobEngine>;
  automationService: ReturnType<typeof createAutomationService>;
  automationPlannerService: ReturnType<typeof createAutomationPlannerService>;
  automationIngressService?: ReturnType<typeof createAutomationIngressService> | null;
  githubPollingService?: ReturnType<typeof createGithubPollingService> | null;
  missionService: ReturnType<typeof createMissionService>;
  missionPreflightService: ReturnType<typeof createMissionPreflightService>;
  orchestratorService: ReturnType<typeof createOrchestratorService>;
  missionBudgetService: ReturnType<typeof createMissionBudgetService>;
  aiOrchestratorService: ReturnType<typeof createAiOrchestratorService>;
  projectConfigService: ReturnType<typeof createProjectConfigService>;
  processService: ReturnType<typeof createProcessService>;
  testService: ReturnType<typeof createTestService>;
  sessionDeltaService?: SessionDeltaService | null;
  ctoStateService?: ReturnType<typeof createCtoStateService> | null;
  workerAgentService?: ReturnType<typeof createWorkerAgentService> | null;
  adeProjectService?: AdeProjectService | null;
  workerRevisionService?: ReturnType<typeof createWorkerRevisionService> | null;
  workerBudgetService?: ReturnType<typeof createWorkerBudgetService> | null;
  workerHeartbeatService?: ReturnType<typeof createWorkerHeartbeatService> | null;
  workerTaskSessionService?: ReturnType<typeof createWorkerTaskSessionService> | null;
  linearCredentialService?: ReturnType<typeof createLinearCredentialService> | null;
  linearIssueTracker?: ReturnType<typeof createLinearIssueTracker> | null;
  flowPolicyService?: ReturnType<typeof createFlowPolicyService> | null;
  linearRoutingService?: ReturnType<typeof createLinearRoutingService> | null;
  linearIngressService?: ReturnType<typeof createLinearIngressService> | null;
  linearSyncService?: ReturnType<typeof createLinearSyncService> | null;
  usageTrackingService?: ReturnType<typeof createUsageTrackingService> | null;
  budgetCapService?: ReturnType<typeof createBudgetCapService> | null;
  configReloadService?: ConfigReloadService | null;
  syncHostService?: ReturnType<typeof createSyncHostService> | null;
  syncService?: ReturnType<typeof createSyncService> | null;
  rpcSocketServer?: NetServer;
  rpcSocketPath?: string;
  apnsService?: import("../notifications/apnsService").ApnsService | null;
  apnsKeyStore?: import("../notifications/apnsService").ApnsKeyStore | null;
  notificationEventBus?: import("../notifications/notificationEventBus").NotificationEventBus | null;
  autoUpdateService?: ReturnType<typeof createAutoUpdateService> | null;
  feedbackReporterService?: ReturnType<typeof createFeedbackReporterService> | null;
};

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
  "mission_planning",
  "orchestrator",
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


function normalizeAutopilotExecutor(value: unknown): OrchestratorExecutorKind {
  const raw = typeof value === "string" ? value.trim() : "";
  if (
    raw === "shell"
    || raw === "manual"
    || raw === "opencode"
    || raw === "codex"
    || raw === "claude"
    || raw === "cursor"
    || raw === "droid"
  ) return raw;
  return "opencode";
}

const RUNTIME_CURSOR_DOC_REF_TRANSPORT_LIMIT = 12;
const PAYLOAD_DOC_REF_TRANSPORT_LIMIT = 12;
const RUN_GRAPH_CONTEXT_SNAPSHOT_TRANSPORT_LIMIT = 5;
const CHAT_TOOL_RESULT_STRING_LIMIT = 1_200;
const CHAT_TOOL_RESULT_ARRAY_PREVIEW_LIMIT = 5;
const CHAT_TOOL_RESULT_KEY_PREVIEW_LIMIT = 12;

function isAdeInternalDocPath(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const normalized = value.replace(/\\/g, "/");
  return normalized === ".ade" || normalized.startsWith(".ade/") || normalized.includes("/.ade/");
}

function compactRuntimeCursorForTransport(value: unknown): unknown {
  if (!isRecord(value)) return value;
  const rawDocs = Array.isArray(value.docs) ? value.docs : [];
  const docs = rawDocs
    .filter((entry) => !isAdeInternalDocPath(isRecord(entry) ? entry.path : null))
    .slice(0, RUNTIME_CURSOR_DOC_REF_TRANSPORT_LIMIT)
    .map((entry) => {
      if (!isRecord(entry)) return entry;
      return {
        path: typeof entry.path === "string" ? entry.path : "",
        bytes: typeof entry.bytes === "number" ? entry.bytes : 0,
        sha256: typeof entry.sha256 === "string" ? entry.sha256 : "",
        truncated: entry.truncated === true,
        mode: typeof entry.mode === "string" ? entry.mode : undefined,
      };
    });
  return {
    ...value,
    docs,
    docsOmittedCount: Math.max(0, rawDocs.length - docs.length),
  };
}

function compactDocRefsArrayForTransport(rawDocs: unknown[], limit: number): unknown[] {
  return rawDocs
    .filter((entry) => !isAdeInternalDocPath(isRecord(entry) ? entry.path : null))
    .slice(0, limit);
}

function compactPayloadForTransport(payload: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!payload) return payload;
  const next: Record<string, unknown> = { ...payload };
  if (Array.isArray(next.docsRefs)) {
    const rawDocsRefs = next.docsRefs;
    const docsRefs = compactDocRefsArrayForTransport(rawDocsRefs, PAYLOAD_DOC_REF_TRANSPORT_LIMIT);
    next.docsRefs = docsRefs;
    next.docsRefsOmittedCount = Math.max(0, rawDocsRefs.length - docsRefs.length);
  }
  return next;
}

function compactChatToolValueForTransport(value: unknown): unknown {
  if (value == null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") {
    if (value.length <= CHAT_TOOL_RESULT_STRING_LIMIT) return value;
    return {
      preview: value.slice(0, CHAT_TOOL_RESULT_STRING_LIMIT),
      omittedChars: value.length - CHAT_TOOL_RESULT_STRING_LIMIT,
    };
  }
  if (Array.isArray(value)) {
    return {
      type: "array",
      length: value.length,
      preview: value
        .slice(0, CHAT_TOOL_RESULT_ARRAY_PREVIEW_LIMIT)
        .map((entry) => compactChatToolValueForTransport(entry)),
      omittedItems: Math.max(0, value.length - CHAT_TOOL_RESULT_ARRAY_PREVIEW_LIMIT),
    };
  }
  if (!isRecord(value)) return value;

  const safeKeys = [
    "ok",
    "status",
    "outcome",
    "summary",
    "message",
    "error",
    "workerId",
    "stepId",
    "stepKey",
    "runId",
    "missionId",
    "filesChanged",
    "testsRun",
    "artifacts",
  ];
  const next: Record<string, unknown> = {};
  for (const key of safeKeys) {
    if (Object.prototype.hasOwnProperty.call(value, key)) {
      next[key] = compactChatToolValueForTransport(value[key]);
    }
  }
  const keys = Object.keys(value);
  next.__adeTransportCompact = true;
  next.keys = keys.slice(0, CHAT_TOOL_RESULT_KEY_PREVIEW_LIMIT);
  next.omittedKeys = Math.max(0, keys.length - CHAT_TOOL_RESULT_KEY_PREVIEW_LIMIT);
  return next;
}

function compactChatMessageMetadataForTransport(metadata: OrchestratorChatMessage["metadata"]): OrchestratorChatMessage["metadata"] {
  if (!isRecord(metadata)) return metadata;
  const structuredStream = isRecord(metadata.structuredStream) ? metadata.structuredStream : null;
  if (!structuredStream) return metadata;
  const nextStructured = { ...structuredStream };
  if (Object.prototype.hasOwnProperty.call(nextStructured, "result")) {
    nextStructured.result = compactChatToolValueForTransport(nextStructured.result);
  }
  return {
    ...metadata,
    structuredStream: nextStructured,
  };
}

function compactChatMessageForTransport(message: OrchestratorChatMessage): OrchestratorChatMessage {
  return {
    ...message,
    metadata: compactChatMessageMetadataForTransport(message.metadata),
  };
}

function compactRunMetadataForTransport(metadata: OrchestratorRun["metadata"]): OrchestratorRun["metadata"] {
  if (!isRecord(metadata)) return metadata;
  const next: Record<string, unknown> = { ...metadata };
  if (isRecord(next.runtimeCursor)) {
    next.runtimeCursor = compactRuntimeCursorForTransport(next.runtimeCursor);
  }
  return next;
}

function compactRunForTransport(run: OrchestratorRun): OrchestratorRun {
  return {
    ...run,
    metadata: compactRunMetadataForTransport(run.metadata),
  };
}

function compactRunGraphForTransport(graph: OrchestratorRunGraph): OrchestratorRunGraph {
  return {
    ...graph,
    run: compactRunForTransport(graph.run),
    contextSnapshots: graph.contextSnapshots
      .slice(0, RUN_GRAPH_CONTEXT_SNAPSHOT_TRANSPORT_LIMIT)
      .map((snapshot) => ({
        ...snapshot,
        cursor: compactRuntimeCursorForTransport(snapshot.cursor) as typeof snapshot.cursor,
      })),
    handoffs: graph.handoffs.map((handoff) => ({
      ...handoff,
      payload: compactPayloadForTransport(handoff.payload) ?? {},
    })),
    timeline: graph.timeline.map((event) => ({
      ...event,
      detail: compactPayloadForTransport(event.detail),
    })),
    runtimeEvents: graph.runtimeEvents?.map((event) => ({
      ...event,
      payload: compactPayloadForTransport(event.payload),
    })),
  };
}

/**
 * Strict resolver for identity-pinned sessions (CTO + worker agents). Requires
 * an actual primary lane and never slips a foreign lane through via a
 * `lanes[0]` fallback — if there is no primary lane the caller must surface
 * the error rather than silently landing the identity on a non-primary lane.
 */
async function resolvePrimaryLaneIdOnly(ctx: AppContext): Promise<string> {
  await ctx.laneService.ensurePrimaryLane().catch(() => {});
  const lanes = await ctx.laneService.list({ includeArchived: false, includeStatus: false });
  return lanes.find((lane) => lane.laneType === "primary")?.id ?? "";
}

async function resolveLaneOverlayContext(ctx: AppContext, laneId: string) {
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

function buildIssueResolutionInstructionsFromThread(arg: LaunchPrIssueResolutionFromThreadArgs): string {
  const lines: string[] = [
    `Focus on review thread ${arg.threadId} on PR ${arg.prId}.`,
  ];
  if (arg.commentId) {
    lines.push(`The relevant comment id is ${arg.commentId}.`);
  }
  const fileContext = arg.fileContext;
  if (fileContext?.path) {
    const lineNumber = fileContext.startLine ?? fileContext.line ?? null;
    lines.push(
      lineNumber != null
        ? `Start by inspecting ${fileContext.path}:${lineNumber}.`
        : `Start by inspecting ${fileContext.path}.`,
    );
  }
  if (arg.additionalInstructions) {
    lines.push("");
    lines.push(arg.additionalInstructions);
  }
  return lines.join("\n");
}

export function registerIpc({
  getCtx,
  getSyncService,
  resolveSyncService,
  runWithIpcWindow,
  getWindowSession,
  setWindowProjectTabs,
  bindRemoteProject,
  localRuntimeConnectionPool,
  createWindow,
  closeWindow,
  switchProjectFromDialog,
  closeCurrentProject,
  closeProjectByPath,
  globalStatePath,
  builtInBrowserService,
}: {
  getCtx: () => AppContext;
  getSyncService?: () => ReturnType<typeof createSyncService> | null | undefined;
  resolveSyncService?: () => Promise<ReturnType<typeof createSyncService> | null | undefined>;
  runWithIpcWindow?: <T>(event: { sender: Electron.WebContents }, fn: () => T | Promise<T>) => T | Promise<T>;
  getWindowSession?: (windowId: number | null) => { windowId: number | null; project: ProjectInfo | null; binding: OpenProjectBinding | null; openProjectTabs?: ProjectInfo[] };
  setWindowProjectTabs?: (windowId: number | null, rootPaths: string[]) => ProjectInfo[];
  bindRemoteProject?: (windowId: number | null, binding: OpenProjectBinding & { kind: "remote" }) => void;
  localRuntimeConnectionPool?: LocalRuntimeConnectionPool | null;
  createWindow?: (args?: { projectRoot?: string | null }) => Promise<{ windowId: number | null; project: ProjectInfo | null }>;
  closeWindow?: (windowId: number | null) => Promise<{ closed: boolean }>;
  switchProjectFromDialog: (selectedPath: string) => Promise<ProjectInfo>;
  closeCurrentProject: () => Promise<void>;
  closeProjectByPath: (projectRoot: string) => Promise<void>;
  globalStatePath: string;
  builtInBrowserService?: ReturnType<typeof createBuiltInBrowserService> | null;
}) {
  const watcherCleanupBoundSenders = new Set<number>();
  let linearOAuthService: LinearOAuthService | null = null;
  let linearOAuthServiceAdeDir: string | null = null;
  const appControlRateBuckets = new Map<string, { windowStartMs: number; count: number }>();
  const builtInBrowserRateBuckets = new Map<string, { windowStartMs: number; count: number }>();
  const macosVmRateBuckets = new Map<string, { windowStartMs: number; count: number }>();

  const getOptionalSyncService = (): ReturnType<typeof createSyncService> | null => {
    if (getSyncService) return getSyncService() ?? null;
    return getCtx().syncService ?? null;
  };
  const resolveOptionalSyncService = async (): Promise<ReturnType<typeof createSyncService> | null> =>
    resolveSyncService
      ? (await resolveSyncService()) ?? null
      : getOptionalSyncService();
  const localRuntimeDaemonDisabled =
    process.env.ADE_DISABLE_LOCAL_RUNTIME_DAEMON === "1";
  const allowLocalRuntimeFallback =
    process.env.ADE_LOCAL_RUNTIME_FALLBACK === "1" ||
    localRuntimeDaemonDisabled;

  const unavailableSyncPlatform =
    process.platform === "darwin"
      ? "macOS"
      : process.platform === "win32"
        ? "windows"
        : process.platform === "linux"
          ? "linux"
          : "unknown";
  const buildUnavailableSyncSnapshot = (): SyncRoleSnapshot => {
    const now = new Date().toISOString();
    const unavailableSyncDevice: SyncDeviceRecord = {
      deviceId: "local-runtime-disabled",
      siteId: "local-runtime-disabled",
      name: "Local desktop",
      platform: unavailableSyncPlatform,
      deviceType: "desktop",
      createdAt: now,
      updatedAt: now,
      lastSeenAt: now,
      lastHost: null,
      lastPort: null,
      tailscaleIp: null,
      ipAddresses: [],
      metadata: { unavailableReason: "local_runtime_daemon_disabled" },
    };
    const unavailableMessage = "Sync service unavailable in local runtime disabled mode.";
    return {
      mode: "standalone",
      role: "brain",
      localDevice: unavailableSyncDevice,
      currentBrain: unavailableSyncDevice,
      clusterState: null,
      bootstrapToken: null,
      pairingPin: null,
      pairingPinConfigured: false,
      pairingConnectInfo: null,
      connectedPeers: [],
      tailnetDiscovery: {
        state: "disabled",
        serviceName: "ade-sync",
        servicePort: 0,
        target: null,
        updatedAt: now,
        error: unavailableMessage,
        stderr: null,
      },
      client: {
        state: "disconnected",
        host: null,
        port: null,
        connectedAt: null,
        lastSeenAt: null,
        latencyMs: null,
        syncLag: null,
        lastRemoteDbVersion: 0,
        brainDeviceId: unavailableSyncDevice.deviceId,
        hostName: unavailableSyncDevice.name,
        error: unavailableMessage,
        message: unavailableMessage,
        savedDraft: null,
      },
      transferReadiness: {
        ready: false,
        blockers: [{
          kind: "managed_process",
          id: "local-runtime-disabled",
          label: "Sync unavailable",
          detail: unavailableMessage,
        }],
        survivableState: [],
      },
      survivableStateText: "",
      blockingStateText: unavailableMessage,
    };
  };

  const buildUnavailableSyncRuntimeDevice = (): SyncDeviceRuntimeState => {
    const snapshot = buildUnavailableSyncSnapshot();
    return {
      ...snapshot.localDevice,
      isLocal: true,
      isBrain: false,
      connectionState: "disconnected",
      connectedAt: null,
      lastAppliedAt: null,
      remoteAddress: null,
      remotePort: null,
      latencyMs: null,
      syncLag: null,
    };
  };

  const requireSyncService = async (): Promise<ReturnType<typeof createSyncService>> => {
    const service = await resolveOptionalSyncService();
    if (!service) {
      throw new Error("Sync service is not available.");
    }
    return service;
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
    if (localRuntimeDaemonDisabled) return null;
    if (!localRuntimeConnectionPool) return null;
    const rootPath = getLocalRuntimeRootForEvent(event);
    if (!rootPath) return null;
    try {
      return await action(localRuntimeConnectionPool, rootPath);
    } catch (error) {
      if (!allowLocalRuntimeFallback) {
        throw error;
      }
      return null;
    }
  };

  // Backend services use Error.code for known failures (e.g.
  // "github_not_connected", "remote_already_exists"). Electron IPC strips
  // custom properties from thrown errors, so we re-throw with the code
  // prepended to the message. Renderer matches on the prefix.
  const surfaceCodedError = (error: unknown): never => {
    if (error instanceof Error) {
      const code = (error as Error & { code?: unknown }).code;
      if (typeof code === "string" && code.length > 0 && !error.message.startsWith(`${code}:`)) {
        const wrapped = new Error(`${code}: ${error.message}`);
        throw wrapped;
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
    [IPC.builtInBrowserNavigate]: new Set(["url"]),
    [IPC.builtInBrowserCreateTab]: new Set(["url"]),
    [IPC.builtInBrowserShowPanel]: new Set(["url"]),
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

  if (traceIpcInvokes && !tracedIpcMain.__adeTraceWrapped) {
    const originalHandle = tracedIpcMain.handle.bind(ipcMain);
    tracedIpcMain.__adeOriginalHandle = originalHandle;
    tracedIpcMain.handle = ((channel, listener) =>
      originalHandle(channel, async (event, ...args) => {
        const callId = ++ipcInvokeSeq;
        const startedAt = Date.now();
        const winId = BrowserWindow.fromWebContents(event.sender)?.id ?? null;
        const logger = getTraceLogger();
        if (traceEveryIpcInvoke) {
          logger.info("ipc.invoke.begin", {
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
        try {
          const result = await Promise.race([
            listener(event, ...args),
            new Promise<never>((_, reject) => {
              timeoutHandle = setTimeout(
                () => reject(new Error(`IPC handler for '${channel}' timed out after ${IPC_TIMEOUT_MS}ms (callId=${callId})`)),
                IPC_TIMEOUT_MS,
              );
            }),
          ]);
          const durationMs = Date.now() - startedAt;
          recordIpcInvokeAggregate({ channel, winId, durationMs, failed: false });
          if (traceEveryIpcInvoke || durationMs >= 120) {
            logger.info("ipc.invoke.done", {
              callId,
              channel,
              winId,
              durationMs,
              result: summarizeIpcValue(result),
            });
          }
          return result;
        } catch (error) {
          const durationMs = Date.now() - startedAt;
          recordIpcInvokeAggregate({ channel, winId, durationMs, failed: true });
          logger.warn("ipc.invoke.failed", {
            callId,
            channel,
            winId,
            durationMs,
            err: getErrorMessage(error),
          });
          throw error;
        } finally {
          if (timeoutHandle) clearTimeout(timeoutHandle);
        }
      })) as typeof ipcMain.handle;
    tracedIpcMain.__adeTraceWrapped = true;
  }

  const ensureComputerUseBroker = (): AppContext => {
    const ctx = getCtx();
    if (!ctx.computerUseArtifactBrokerService) {
      throw new Error("Computer-use artifact broker is not available.");
    }
    return ctx;
  };

  const ensureIosSimulator = (): NonNullable<AppContext["iosSimulatorService"]> => {
    const service = getCtx().iosSimulatorService;
    if (!service) {
      throw new Error("iOS Simulator service is not available.");
    }
    return service;
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

  const ensureMacosVm = (): NonNullable<AppContext["macosVmService"]> => {
    const service = getCtx().macosVmService;
    if (!service) {
      throw new Error("macOS VM service is not available.");
    }
    return service;
  };

  /**
   * The macOS VM feature is unsigned-dev only — `MacVmProductionGate` hides
   * the renderer UI in packaged builds, but the IPC handlers were still
   * reachable from anywhere in the renderer. Block side-effectful VM
   * operations in packaged builds so a packaged build cannot reach VM
   * provisioning, runtime install, or credential storage even if a stale tab
   * or compromised renderer asks for it. Read-only `getStatus`/`getStorageInfo`
   * remain reachable so other UI surfaces (e.g. LanesPage gating logic) keep
   * working. Bypassable via ADE_FORCE_ENABLE_MACOS_VM=1 for QA.
   */
  const requireMacosVmEnabledInProduction = (channel: string): void => {
    if (!app.isPackaged) return;
    if (process.env.ADE_FORCE_ENABLE_MACOS_VM === "1") return;
    throw new Error(
      `macOS VM is disabled in packaged builds (${channel}). Run from source or set ADE_FORCE_ENABLE_MACOS_VM=1.`,
    );
  };

  const resolveMacosVmProjectRootForEvent = (event: IpcMainInvokeEvent): string => {
    const windowId = BrowserWindow.fromWebContents(event.sender)?.id ?? null;
    const session = getWindowSession?.(windowId) ?? null;
    if (session?.binding?.kind === "local") return session.binding.rootPath;
    if (session?.project?.rootPath) return session.project.rootPath;
    // `ctx.project` is otherwise treated as unsafe unless the user has
    // explicitly selected a project — without that guard a window with no
    // selected project would silently delete VM state from whichever project
    // happened to be in ctx, instead of failing closed.
    const ctx = getCtx();
    if (ctx.hasUserSelectedProject && ctx.project?.rootPath) return ctx.project.rootPath;
    throw new Error("A project is required to remove a macOS VM.");
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
  ): void => {
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
  };

  const guardMacosVmIpc = (
    event: IpcMainInvokeEvent,
    channel: string,
    limit: { windowMs: number; max: number } = { windowMs: 10_000, max: 30 },
  ): void => {
    assertTrustedAppControlSender(event, channel);
    const now = Date.now();
    const key = `${event.sender.id}:${channel}`;
    for (const [k, v] of macosVmRateBuckets) {
      if (now - v.windowStartMs > limit.windowMs) {
        macosVmRateBuckets.delete(k);
      }
    }
    const bucket = macosVmRateBuckets.get(key);
    if (!bucket || now - bucket.windowStartMs > limit.windowMs) {
      macosVmRateBuckets.set(key, { windowStartMs: now, count: 1 });
      return;
    }
    if (bucket.count >= limit.max) {
      const win = BrowserWindow.fromWebContents(event.sender);
      getCtx().logger.warn("ipc.macos_vm.rate_limited", {
        channel,
        windowId: win?.id ?? null,
        count: bucket.count,
        windowMs: limit.windowMs,
      });
      throw new Error("Too many macOS VM requests. Try again shortly.");
    }
    bucket.count += 1;
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
    return { tabId, webContentsId };
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
    return { url, tabId, newTab, openPanel };
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

  const parseBuiltInBrowserTabArgs = (value: unknown, channel: string): BuiltInBrowserTabArgs => {
    const record = builtInBrowserRecord(value, channel, true);
    const tabId = optionalBuiltInBrowserString(record, "tabId", channel, 128);
    if (!tabId) return invalidBuiltInBrowserArg(channel, "tabId must be a non-empty string");
    const openPanel = optionalBoolean(record.openPanel);
    return { tabId, openPanel };
  };

  const parseBuiltInBrowserCreateTabArgs = (value: unknown, channel: string): BuiltInBrowserCreateTabArgs => {
    const record = builtInBrowserRecord(value, channel, false);
    const url = optionalBuiltInBrowserString(record, "url", channel, 4096);
    const activate = record.activate === false ? false : undefined;
    const openPanel = optionalBoolean(record.openPanel);
    return { url, activate, openPanel };
  };

  const parseBuiltInBrowserOpenPanelArgs = (value: unknown, channel: string): BuiltInBrowserOpenPanelArgs => {
    const record = builtInBrowserRecord(value, channel, false);
    const url = optionalBuiltInBrowserString(record, "url", channel, 4096);
    const tabId = optionalBuiltInBrowserString(record, "tabId", channel, 128);
    return { url, tabId };
  };

  const parseBuiltInBrowserSelectPointArgs = (value: unknown, channel: string): BuiltInBrowserSelectPointArgs => {
    const record = builtInBrowserRecord(value, channel, true);
    const includeScreenshot = record.includeScreenshot === false ? false : undefined;
    return {
      x: builtInBrowserNumber(record, "x", channel, { min: 0, max: 100_000 }),
      y: builtInBrowserNumber(record, "y", channel, { min: 0, max: 100_000 }),
      includeScreenshot,
    };
  };

  const invalidMacosVmArg = (channel: string, reason: string): never => {
    getCtx().logger.warn("ipc.macos_vm.invalid_args", { channel, reason });
    throw new Error(`Invalid macOS VM payload: ${reason}`);
  };

  const macosVmRecord = (value: unknown, channel: string, required = false): Record<string, unknown> => {
    if (value == null) {
      if (required) invalidMacosVmArg(channel, "payload object is required");
      return {};
    }
    if (!isRecord(value)) invalidMacosVmArg(channel, "payload must be an object");
    return value as Record<string, unknown>;
  };

  const macosVmString = (
    record: Record<string, unknown>,
    field: string,
    channel: string,
    maxLength: number,
    required = false,
  ): string | null | undefined => {
    const value = record[field];
    if (value == null) {
      if (required) invalidMacosVmArg(channel, `${field} is required`);
      return undefined;
    }
    if (typeof value !== "string") return invalidMacosVmArg(channel, `${field} must be a string`);
    const trimmed = (value as string).trim();
    if (!trimmed.length) {
      if (required) invalidMacosVmArg(channel, `${field} is required`);
      return null;
    }
    if (trimmed.length > maxLength || trimmed.includes("\0")) invalidMacosVmArg(channel, `${field} is invalid`);
    return trimmed;
  };

  const macosVmRawString = (
    record: Record<string, unknown>,
    field: string,
    channel: string,
    maxLength: number,
    required = false,
  ): string | null | undefined => {
    const value = record[field];
    if (value == null) {
      if (required) invalidMacosVmArg(channel, `${field} is required`);
      return undefined;
    }
    if (typeof value !== "string") return invalidMacosVmArg(channel, `${field} must be a string`);
    if (!value.length) {
      if (required) invalidMacosVmArg(channel, `${field} is required`);
      return null;
    }
    if (value.length > maxLength || value.includes("\0")) invalidMacosVmArg(channel, `${field} is invalid`);
    return value;
  };

  const macosVmNumber = (
    record: Record<string, unknown>,
    field: string,
    channel: string,
    options: { integer?: boolean; min?: number; max?: number } = {},
  ): number | undefined => {
    const value = record[field];
    if (value == null) return undefined;
    if (typeof value !== "number" || !Number.isFinite(value)) invalidMacosVmArg(channel, `${field} must be a finite number`);
    const numberValue = value as number;
    if (options.integer && !Number.isInteger(numberValue)) invalidMacosVmArg(channel, `${field} must be an integer`);
    if (options.min != null && numberValue < options.min) invalidMacosVmArg(channel, `${field} is below the minimum`);
    if (options.max != null && numberValue > options.max) invalidMacosVmArg(channel, `${field} is above the maximum`);
    return numberValue;
  };

  const macosVmBoolean = (record: Record<string, unknown>, field: string, channel: string): boolean | undefined => {
    const value = record[field];
    if (value == null) return undefined;
    if (typeof value !== "boolean") return invalidMacosVmArg(channel, `${field} must be a boolean`);
    return value as boolean;
  };

  const macosVmLaneArgs = (value: unknown, channel: string): { laneId: string } => {
    const record = macosVmRecord(value, channel, true);
    const laneId = macosVmString(record, "laneId", channel, 512, true);
    return { laneId: laneId as string };
  };

  const parseMacosVmStatusArgs = (value: unknown, channel: string): MacosVmStatusArgs => {
    const record = macosVmRecord(value, channel, false);
    const laneId = macosVmString(record, "laneId", channel, 512);
    return { laneId };
  };

  const parseMacosVmProvisionArgs = (value: unknown, channel: string): MacosVmProvisionArgs => {
    const record = macosVmRecord(value, channel, true);
    const laneId = macosVmString(record, "laneId", channel, 512, true) as string;
    const modeValue = record.mode;
    if (modeValue != null && modeValue !== "create" && modeValue !== "pull-image") {
      invalidMacosVmArg(channel, "mode must be create or pull-image");
    }
    return {
      laneId,
      name: macosVmString(record, "name", channel, 256),
      cpuCores: macosVmNumber(record, "cpuCores", channel, { integer: true, min: 1, max: 32 }),
      memory: macosVmString(record, "memory", channel, 32),
      diskSize: macosVmString(record, "diskSize", channel, 32),
      display: macosVmString(record, "display", channel, 32),
      mode: modeValue === "pull-image" ? "pull-image" : modeValue === "create" ? "create" : undefined,
      ipsw: macosVmString(record, "ipsw", channel, 4096),
      sourceImage: macosVmString(record, "sourceImage", channel, 256),
      unattendedPreset: macosVmString(record, "unattendedPreset", channel, 128),
      force: macosVmBoolean(record, "force", channel),
    };
  };

  const parseMacosVmStartArgs = (value: unknown, channel: string): MacosVmStartArgs => {
    const record = macosVmRecord(value, channel, true);
    const laneId = macosVmString(record, "laneId", channel, 512, true) as string;
    const modeValue = record.mode;
    if (modeValue != null && modeValue !== "create" && modeValue !== "pull-image") {
      invalidMacosVmArg(channel, "mode must be create or pull-image");
    }
    return {
      laneId,
      openDisplay: macosVmBoolean(record, "openDisplay", channel),
      createIfMissing: macosVmBoolean(record, "createIfMissing", channel),
      cpuCores: macosVmNumber(record, "cpuCores", channel, { integer: true, min: 1, max: 32 }),
      memory: macosVmString(record, "memory", channel, 32),
      diskSize: macosVmString(record, "diskSize", channel, 32),
      display: macosVmString(record, "display", channel, 32),
      mode: modeValue === "pull-image" ? "pull-image" : modeValue === "create" ? "create" : undefined,
      ipsw: macosVmString(record, "ipsw", channel, 4096),
      sourceImage: macosVmString(record, "sourceImage", channel, 256),
      unattendedPreset: macosVmString(record, "unattendedPreset", channel, 128),
    };
  };

  const parseMacosVmStopArgs = (value: unknown, channel: string): MacosVmStopArgs => {
    const record = macosVmRecord(value, channel, true);
    return {
      laneId: macosVmString(record, "laneId", channel, 512, true) as string,
      force: macosVmBoolean(record, "force", channel),
    };
  };

  const parseMacosVmDeleteArgs = (value: unknown, channel: string): MacosVmDeleteArgs => {
    const record = macosVmRecord(value, channel, true);
    const laneId = macosVmString(record, "laneId", channel, 512);
    const vmName = macosVmString(record, "vmName", channel, 256);
    if (!laneId && !vmName) invalidMacosVmArg(channel, "laneId or vmName is required");
    return {
      laneId,
      vmName,
      force: macosVmBoolean(record, "force", channel),
    };
  };

  const parseMacosVmAgentGuideArgs = (value: unknown, channel: string): MacosVmAgentGuideArgs =>
    macosVmLaneArgs(value, channel);

  const parseMacosVmFocusWindowArgs = (value: unknown, channel: string): MacosVmFocusWindowArgs => {
    const record = macosVmRecord(value, channel, true);
    return {
      laneId: macosVmString(record, "laneId", channel, 512, true) as string,
      windowTitleQuery: macosVmString(record, "windowTitleQuery", channel, 256),
    };
  };

  const parseMacosVmDisplaySessionArgs = (value: unknown, channel: string): MacosVmDisplaySessionArgs =>
    macosVmLaneArgs(value, channel);

  const parseMacosVmCaptureScreenshotArgs = (value: unknown, channel: string): MacosVmCaptureScreenshotArgs => {
    const record = macosVmRecord(value, channel, true);
    return {
      laneId: macosVmString(record, "laneId", channel, 512, true) as string,
      windowTitleQuery: macosVmString(record, "windowTitleQuery", channel, 256),
      outputPath: macosVmString(record, "outputPath", channel, 4096),
    };
  };

  const parseMacosVmClickArgs = (value: unknown, channel: string): MacosVmClickArgs => {
    const record = macosVmRecord(value, channel, true);
    const coordinateSpace = record.coordinateSpace;
    if (coordinateSpace != null && coordinateSpace !== "window" && coordinateSpace !== "screen") {
      invalidMacosVmArg(channel, "coordinateSpace must be window or screen");
    }
    const x = macosVmNumber(record, "x", channel, { min: 0, max: 100_000 });
    const y = macosVmNumber(record, "y", channel, { min: 0, max: 100_000 });
    if (x == null) invalidMacosVmArg(channel, "x is required");
    if (y == null) invalidMacosVmArg(channel, "y is required");
    return {
      laneId: macosVmString(record, "laneId", channel, 512, true) as string,
      x: x as number,
      y: y as number,
      coordinateSpace: coordinateSpace === "screen" ? "screen" : coordinateSpace === "window" ? "window" : undefined,
      windowTitleQuery: macosVmString(record, "windowTitleQuery", channel, 256),
    };
  };

  const parseMacosVmSelectPointArgs = (value: unknown, channel: string): MacosVmSelectPointArgs => {
    const record = macosVmRecord(value, channel, true);
    const coordinateSpace = record.coordinateSpace;
    if (coordinateSpace != null && coordinateSpace !== "window" && coordinateSpace !== "screen") {
      invalidMacosVmArg(channel, "coordinateSpace must be window or screen");
    }
    const x = macosVmNumber(record, "x", channel, { min: 0, max: 100_000 });
    const y = macosVmNumber(record, "y", channel, { min: 0, max: 100_000 });
    if (x == null) invalidMacosVmArg(channel, "x is required");
    if (y == null) invalidMacosVmArg(channel, "y is required");
    return {
      laneId: macosVmString(record, "laneId", channel, 512, true) as string,
      x: x as number,
      y: y as number,
      coordinateSpace: coordinateSpace === "screen" ? "screen" : coordinateSpace === "window" ? "window" : undefined,
      windowTitleQuery: macosVmString(record, "windowTitleQuery", channel, 256),
      includeScreenshot: macosVmBoolean(record, "includeScreenshot", channel),
    };
  };

  const parseMacosVmTypeTextArgs = (value: unknown, channel: string): MacosVmTypeTextArgs => {
    const record = macosVmRecord(value, channel, true);
    return {
      laneId: macosVmString(record, "laneId", channel, 512, true) as string,
      text: macosVmRawString(record, "text", channel, 20_000, true) as string,
      windowTitleQuery: macosVmString(record, "windowTitleQuery", channel, 256),
    };
  };

  const parseMacosVmRestartArgs = (value: unknown, channel: string): MacosVmRestartArgs => {
    const record = macosVmRecord(value, channel, false);
    return {
      vmName: macosVmString(record, "vmName", channel, 256),
      laneId: macosVmString(record, "laneId", channel, 512),
      force: macosVmBoolean(record, "force", channel),
    };
  };

  const parseMacosVmWipeArgs = (value: unknown, channel: string): MacosVmWipeArgs => {
    const record = macosVmRecord(value, channel, true);
    const confirm = macosVmBoolean(record, "confirm", channel);
    if (confirm !== true) invalidMacosVmArg(channel, "confirm must be true to wipe a VM");
    return {
      vmName: macosVmString(record, "vmName", channel, 256),
      laneId: macosVmString(record, "laneId", channel, 512),
      confirm: true,
    };
  };

  const parseMacosVmInstallRuntimeArgs = (value: unknown, channel: string): MacosVmInstallRuntimeArgs => {
    const record = macosVmRecord(value, channel, false);
    return {
      vmName: macosVmString(record, "vmName", channel, 256),
      laneId: macosVmString(record, "laneId", channel, 512),
    };
  };

  const parseMacosVmSetCredentialsArgs = (value: unknown, channel: string): MacosVmSetCredentialsArgs => {
    const record = macosVmRecord(value, channel, true);
    const vmName = macosVmString(record, "vmName", channel, 256, true) as string;
    const username = macosVmString(record, "username", channel, 64, true) as string;
    const password = macosVmRawString(record, "password", channel, 1024, true) as string;
    return { vmName, username, password };
  };

  const parseMacosVmGetCredentialsArgs = (value: unknown, channel: string): MacosVmGetCredentialsArgs => {
    const record = macosVmRecord(value, channel, true);
    return {
      vmName: macosVmString(record, "vmName", channel, 256, true) as string,
    };
  };

  const parseMacosVmDetachLaneArgs = (value: unknown, channel: string): MacosVmDetachLaneArgs => {
    const record = macosVmRecord(value, channel, true);
    return {
      laneId: macosVmString(record, "laneId", channel, 512, true) as string,
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
    return { x: x as number, y: y as number, ...(scale !== undefined ? { scale } : {}) };
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
    const urlRaw = typeof arg?.url === "string" ? arg.url.trim() : "";
    if (!urlRaw) return;
    let parsed: URL;
    try {
      parsed = new URL(urlRaw);
    } catch {
      throw new Error("Invalid URL");
    }
    const ALLOWED_URL_SCHEMES = new Set(["http:", "https:", "mailto:"]);
    if (!ALLOWED_URL_SCHEMES.has(parsed.protocol)) {
      throw new Error("Only http(s) and mailto: URLs are allowed.");
    }
    await shell.openExternal(parsed.toString());
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
      });
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

  ipcMain.handle(IPC.projectOpenRepo, async (event, args: { rootPath?: string } = {}): Promise<ProjectInfo | null> => {
    const requestedRoot = args.rootPath?.trim();
    if (requestedRoot) {
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
    return await switchProjectFromDialog(selected);
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
    entries: Array<{ rootPath: string; displayName: string; lastOpenedAt: string }>,
  ): string => JSON.stringify(entries.map((entry) => [
    entry.rootPath,
    entry.displayName,
    entry.lastOpenedAt,
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
    const rows = entries.map(toRecentProjectSummary);
    recentProjectSummaryCache = {
      signature,
      rows,
      expiresAtMs: now + RECENT_PROJECT_SUMMARY_CACHE_TTL_MS,
    };
    return rows;
  };
  const clearRecentProjectSummaryCache = (): void => {
    recentProjectSummaryCache = null;
  };

  ipcMain.handle(IPC.projectListRecent, async (): Promise<RecentProjectSummary[]> =>
    listRecentProjectSummaries()
  );

  registerRuntimeBridge({
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
    return ctx.projectScaffoldService.getDefaultParentDir(listRecentProjectSummaries());
  });

  ipcMain.handle(IPC.projectCloseCurrent, async (): Promise<void> => {
    await closeCurrentProject();
  });

  ipcMain.handle(IPC.projectForgetRecent, async (_event, arg: { rootPath: string }): Promise<RecentProjectSummary[]> => {
    const rootPath = typeof arg?.rootPath === "string" ? arg.rootPath.trim() : "";
    const state = readGlobalState(globalStatePath);
    if (!rootPath) {
      return listRecentProjectSummaries();
    }
    const filtered = (state.recentProjects ?? []).filter((entry) => entry.rootPath !== rootPath);
    const next = { ...state, recentProjects: filtered };
    if (next.lastProjectRoot === rootPath) {
      delete next.lastProjectRoot;
    }
    writeGlobalState(globalStatePath, next);
    clearRecentProjectSummaryCache();
    try {
      await closeProjectByPath(rootPath);
    } catch {
      // Best effort; forgetting a project should still update recents even if teardown fails.
    }
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
    const rootPath = typeof arg?.rootPath === "string" ? arg.rootPath.trim() : "";
    if (!rootPath) return getCtx().project;
    const ctx = getCtx();
    if (ctx.hasUserSelectedProject && rootPath === ctx.project.rootPath) return ctx.project;
    return await switchProjectFromDialog(rootPath);
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
    return ctx.keybindingsService.get();
  });

  ipcMain.handle(IPC.keybindingsSet, async (_event, arg: { overrides: KeybindingOverride[] }): Promise<KeybindingsSnapshot> => {
    const ctx = getCtx();
    return ctx.keybindingsService.set({ overrides: arg?.overrides ?? [] });
  });

  ipcMain.handle(IPC.aiGetStatus, async (_event, arg?: { force?: boolean; refreshOpenCodeInventory?: boolean }): Promise<AiSettingsStatus> => {
    const ctx = getCtx();
    if (!ctx.aiIntegrationService) {
      return getUnavailableAiStatus();
    }
    try {
      const status = await ctx.aiIntegrationService.getStatus({
        force: arg?.force === true,
        refreshOpenCodeInventory: arg?.refreshOpenCodeInventory === true,
      });
      // Single query for all feature daily usage instead of N individual queries
      const usageBatch = ctx.aiIntegrationService.getDailyUsageBatch(AI_USAGE_FEATURE_KEYS);
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
          enabled: ctx.aiIntegrationService.getFeatureFlag(feature),
          dailyUsage: usageBatch.get(feature) ?? 0,
          dailyLimit: ctx.aiIntegrationService.getDailyBudgetLimit(feature)
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
      ctx.aiIntegrationService.invalidateProviderReadinessCaches();
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
      ctx.aiIntegrationService.invalidateProviderReadinessCaches();
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
      return await ctx.aiIntegrationService.verifyApiKeyConnection(arg.provider);
    },
  );

  ipcMain.handle(IPC.aiUpdateConfig, async (_event, partial: Partial<AiConfig>): Promise<void> => {
    const ctx = getCtx();
    const snapshot = ctx.projectConfigService.get();
    const currentAi = snapshot.shared?.ai ?? {};
    const merged = mergeAiConfig(currentAi, partial) ?? {};
    ctx.projectConfigService.save({
      shared: { ...snapshot.shared, ai: merged },
      local: snapshot.local ?? {},
    });
  });

  ipcMain.handle(IPC.aiCursorCloudListRepositories, async (): Promise<CursorCloudRepository[]> => {
    const ctx = getCtx();
    return ctx.aiIntegrationService.listCursorCloudRepositories();
  });

  ipcMain.handle(
    IPC.aiCursorCloudListAgents,
    async (_event, arg: { includeArchived?: boolean; limit?: number; cursor?: string | null }): Promise<CursorCloudListAgentsResult> => {
      const ctx = getCtx();
      return ctx.aiIntegrationService.listCursorCloudAgents(arg);
    },
  );

  ipcMain.handle(
    IPC.aiCursorCloudListRuns,
    async (_event, arg: { agentId: string; limit?: number; cursor?: string | null }): Promise<CursorCloudListRunsResult> => {
      const ctx = getCtx();
      return ctx.aiIntegrationService.listCursorCloudRuns(arg);
    },
  );

  ipcMain.handle(
    IPC.aiCursorCloudCreateRun,
    async (_event, arg: CursorCloudCreateRunRequest): Promise<CursorCloudCreateRunResult> => {
      const ctx = getCtx();
      return ctx.aiIntegrationService.createCursorCloudRun(arg);
    },
  );

  ipcMain.handle(IPC.aiCursorCloudArchiveAgent, async (_event, arg: { agentId: string }): Promise<void> => {
    const ctx = getCtx();
    await ctx.aiIntegrationService.archiveCursorCloudAgent(arg.agentId);
  });

  ipcMain.handle(IPC.aiCursorCloudUnarchiveAgent, async (_event, arg: { agentId: string }): Promise<void> => {
    const ctx = getCtx();
    await ctx.aiIntegrationService.unarchiveCursorCloudAgent(arg.agentId);
  });

  ipcMain.handle(IPC.aiCursorCloudDeleteAgent, async (_event, arg: { agentId: string }): Promise<void> => {
    const ctx = getCtx();
    await ctx.aiIntegrationService.deleteCursorCloudAgent(arg.agentId);
  });

  ipcMain.handle(
    IPC.aiCursorCloudGetAgent,
    async (_event, arg: { agentId: string }): Promise<CursorCloudAgentSummary | null> => {
      const ctx = getCtx();
      return await ctx.aiIntegrationService.getCursorCloudAgent(arg.agentId);
    },
  );

  ipcMain.handle(
    IPC.aiCursorCloudListArtifacts,
    async (_event, arg: { agentId: string }): Promise<CursorCloudArtifactSummary[]> => {
      const ctx = getCtx();
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
      return await ctx.aiIntegrationService.downloadCursorCloudArtifact(arg);
    },
  );

  ipcMain.handle(
    IPC.aiCursorCloudCancelRun,
    async (_event, arg: { agentId: string; runId: string }): Promise<void> => {
      const ctx = getCtx();
      await ctx.agentChatService.cancelCursorCloudRun(arg);
    },
  );

  ipcMain.handle(
    IPC.aiCursorCloudFollowUp,
    async (_event, arg: CursorCloudFollowUpRequest): Promise<CursorCloudFollowUpResult> => {
      const ctx = getCtx();
      return await ctx.agentChatService.cursorCloudFollowUp(arg);
    },
  );

  ipcMain.handle(
    IPC.aiCursorCloudOpenChat,
    async (_event, arg: CursorCloudOpenChatRequest): Promise<CursorCloudOpenChatResult> => {
      const ctx = getCtx();
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
    const runtimeStatus = await tryLocalRuntimeSync(event, (pool, rootPath) =>
      pool.syncStatusForRoot(rootPath, arg ?? {})
    );
    if (runtimeStatus) return runtimeStatus;
    const service = await resolveOptionalSyncService();
    if (!service) {
      if (localRuntimeDaemonDisabled) return buildUnavailableSyncSnapshot();
      throw new Error("Sync service is not available.");
    }
    return await service.getStatus({
      includeTransferReadiness: arg?.includeTransferReadiness,
      forceTransferReadiness: arg?.forceTransferReadiness,
    });
  });

  ipcMain.handle(IPC.syncRefreshDiscovery, async (event): Promise<SyncRoleSnapshot> => {
    const runtimeStatus = await tryLocalRuntimeSync(event, (pool, rootPath) =>
      pool.refreshSyncDiscoveryForRoot(rootPath)
    );
    if (runtimeStatus) return runtimeStatus;
    if (localRuntimeDaemonDisabled) return buildUnavailableSyncSnapshot();
    return await (await requireSyncService()).refreshDiscovery();
  });

  ipcMain.handle(IPC.syncListDevices, async (event): Promise<SyncDeviceRuntimeState[]> => {
    const runtimeDevices = await tryLocalRuntimeSync(event, (pool, rootPath) =>
      pool.syncDevicesForRoot(rootPath)
    );
    if (runtimeDevices) return runtimeDevices;
    if (localRuntimeDaemonDisabled) return [buildUnavailableSyncRuntimeDevice()];
    return await (await requireSyncService()).listDevices();
  });

  ipcMain.handle(
    IPC.syncUpdateLocalDevice,
    async (
      event,
      arg: { name?: string; deviceType?: SyncPeerDeviceType },
    ): Promise<SyncDeviceRecord> => {
      const runtimeDevice = await tryLocalRuntimeSync(event, (pool, rootPath) =>
        pool.updateSyncLocalDeviceForRoot(rootPath, {
          name: typeof arg?.name === "string" ? arg.name : undefined,
          deviceType: arg?.deviceType,
        })
      );
      if (runtimeDevice) return runtimeDevice;
      if (localRuntimeDaemonDisabled) return buildUnavailableSyncSnapshot().localDevice;
      return await (await requireSyncService()).updateLocalDevice({
        name: typeof arg?.name === "string" ? arg.name : undefined,
        deviceType: arg?.deviceType,
      });
    },
  );

  ipcMain.handle(
    IPC.syncConnectToBrain,
    async (event, arg: SyncDesktopConnectionDraft): Promise<SyncRoleSnapshot> => {
      const runtimeStatus = await tryLocalRuntimeSync(event, (pool, rootPath) =>
        pool.callSyncForRoot<SyncRoleSnapshot>(
          rootPath,
          "sync.connectToBrain",
          (arg ?? {}) as unknown as Record<string, unknown>,
        )
      );
      if (runtimeStatus) return runtimeStatus;
      if (localRuntimeDaemonDisabled) return buildUnavailableSyncSnapshot();
      return await (await requireSyncService()).connectToBrain(arg);
    },
  );

  ipcMain.handle(IPC.syncDisconnectFromBrain, async (event): Promise<SyncRoleSnapshot> => {
    const runtimeStatus = await tryLocalRuntimeSync(event, (pool, rootPath) =>
      pool.callSyncForRoot<SyncRoleSnapshot>(rootPath, "sync.disconnectFromBrain")
    );
    if (runtimeStatus) return runtimeStatus;
    if (localRuntimeDaemonDisabled) return buildUnavailableSyncSnapshot();
    return await (await requireSyncService()).disconnectFromBrain();
  });

  ipcMain.handle(IPC.syncForgetDevice, async (event, arg: { deviceId: string }): Promise<SyncRoleSnapshot> => {
    const deviceId = typeof arg?.deviceId === "string" ? arg.deviceId : "";
    const runtimeStatus = await tryLocalRuntimeSync(event, (pool, rootPath) =>
      pool.forgetSyncDeviceForRoot(rootPath, deviceId)
    );
    if (runtimeStatus) return runtimeStatus;
    if (localRuntimeDaemonDisabled) return buildUnavailableSyncSnapshot();
    return await (await requireSyncService()).forgetDevice(deviceId);
  });

  ipcMain.handle(IPC.syncGetTransferReadiness, async (event): Promise<SyncTransferReadiness> => {
    const runtimeReadiness = await tryLocalRuntimeSync(event, (pool, rootPath) =>
      pool.callSyncForRoot<SyncTransferReadiness>(rootPath, "sync.getTransferReadiness")
    );
    if (runtimeReadiness) return runtimeReadiness;
    if (localRuntimeDaemonDisabled) return buildUnavailableSyncSnapshot().transferReadiness;
    return await (await requireSyncService()).getTransferReadiness();
  });

  ipcMain.handle(IPC.syncTransferBrainToLocal, async (event): Promise<SyncRoleSnapshot> => {
    const runtimeStatus = await tryLocalRuntimeSync(event, (pool, rootPath) =>
      pool.callSyncForRoot<SyncRoleSnapshot>(rootPath, "sync.transferBrainToLocal")
    );
    if (runtimeStatus) return runtimeStatus;
    if (localRuntimeDaemonDisabled) return buildUnavailableSyncSnapshot();
    return await (await requireSyncService()).transferBrainToLocal();
  });

  ipcMain.handle(IPC.syncGetPin, async (event): Promise<{ pin: string | null }> => {
    const runtimePin = await tryLocalRuntimeSync(event, (pool, rootPath) =>
      pool.syncPinForRoot(rootPath)
    );
    if (runtimePin) return runtimePin;
    if (localRuntimeDaemonDisabled) return { pin: null };
    return { pin: (await requireSyncService()).getPin() };
  });

  ipcMain.handle(IPC.syncSetPin, async (event, pin: string): Promise<SyncRoleSnapshot> => {
    const normalizedPin = typeof pin === "string" ? pin : "";
    const runtimeStatus = await tryLocalRuntimeSync(event, (pool, rootPath) =>
      pool.setSyncPinForRoot(rootPath, normalizedPin)
    );
    if (runtimeStatus) return runtimeStatus;
    if (localRuntimeDaemonDisabled) return buildUnavailableSyncSnapshot();
    return await (await requireSyncService()).setPin(normalizedPin);
  });

  ipcMain.handle(IPC.syncGeneratePin, async (event): Promise<SyncRoleSnapshot> => {
    const runtimeStatus = await tryLocalRuntimeSync(event, (pool, rootPath) =>
      pool.generateSyncPinForRoot(rootPath)
    );
    if (runtimeStatus) return runtimeStatus;
    if (localRuntimeDaemonDisabled) return buildUnavailableSyncSnapshot();
    return await (await requireSyncService()).generatePin();
  });

  ipcMain.handle(IPC.syncClearPin, async (event): Promise<SyncRoleSnapshot> => {
    const runtimeStatus = await tryLocalRuntimeSync(event, (pool, rootPath) =>
      pool.clearSyncPinForRoot(rootPath)
    );
    if (runtimeStatus) return runtimeStatus;
    if (localRuntimeDaemonDisabled) return buildUnavailableSyncSnapshot();
    return await (await requireSyncService()).clearPin();
  });

  ipcMain.handle(
    IPC.syncSetActiveLanePresence,
    async (event, arg: { laneIds?: string[] | null }): Promise<void> => {
      const laneIds = Array.isArray(arg?.laneIds) ? arg.laneIds : [];
      const rootPath = getLocalRuntimeRootForEvent(event);
      if (!localRuntimeDaemonDisabled && localRuntimeConnectionPool && rootPath) {
        try {
          await localRuntimeConnectionPool.callSyncForRoot(rootPath, "sync.setActiveLanePresence", { laneIds });
          return;
        } catch (error) {
          if (!allowLocalRuntimeFallback) {
            throw error;
          }
        }
      }
      const service = await resolveOptionalSyncService();
      if (!service) {
        if (localRuntimeDaemonDisabled) return;
        throw new Error("Sync service is not available.");
      }
      await service.setActiveLanePresence(laneIds);
    },
  );

  ipcMain.handle(IPC.agentToolsDetect, async (): Promise<AgentTool[]> => {
    const ctx = getCtx();
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

  const emptyTourProgress = (): OnboardingTourProgress => ({
    wizardCompletedAt: null,
    wizardDismissedAt: null,
    tours: {},
    tourVariants: {},
    tutorial: {
      completedAt: null,
      dismissedAt: null,
      silenced: false,
      inProgress: false,
      lastActIndex: 0,
      ctxSnapshot: {},
    },
    glossaryTermsSeen: [],
  });

  const coerceVariant = (raw: unknown): OnboardingTourVariant =>
    raw === "highlights" ? "highlights" : "full";

  ipcMain.handle(IPC.onboardingGetTourProgress, async (): Promise<OnboardingTourProgress> => {
    const ctx = getCtx();
    if (!ctx.onboardingService) return emptyTourProgress();
    return ctx.onboardingService.getTourProgress();
  });

  ipcMain.handle(IPC.onboardingMarkWizardCompleted, async (): Promise<OnboardingTourProgress> => {
    const ctx = getCtx();
    if (!ctx.onboardingService) return emptyTourProgress();
    return ctx.onboardingService.markWizardCompleted();
  });

  ipcMain.handle(IPC.onboardingMarkWizardDismissed, async (): Promise<OnboardingTourProgress> => {
    const ctx = getCtx();
    if (!ctx.onboardingService) return emptyTourProgress();
    return ctx.onboardingService.markWizardDismissed();
  });

  ipcMain.handle(
    IPC.onboardingMarkTourCompleted,
    async (_event, arg: { tourId: string }): Promise<OnboardingTourProgress> => {
      const ctx = getCtx();
      if (!ctx.onboardingService) return emptyTourProgress();
      return ctx.onboardingService.markTourCompleted(arg?.tourId ?? "");
    },
  );

  ipcMain.handle(
    IPC.onboardingMarkTourDismissed,
    async (_event, arg: { tourId: string }): Promise<OnboardingTourProgress> => {
      const ctx = getCtx();
      if (!ctx.onboardingService) return emptyTourProgress();
      return ctx.onboardingService.markTourDismissed(arg?.tourId ?? "");
    },
  );

  ipcMain.handle(
    IPC.onboardingUpdateTourStep,
    async (_event, arg: { tourId: string; index: number }): Promise<OnboardingTourProgress> => {
      const ctx = getCtx();
      if (!ctx.onboardingService) return emptyTourProgress();
      const index = typeof arg?.index === "number" ? arg.index : 0;
      return ctx.onboardingService.updateTourStep(arg?.tourId ?? "", index);
    },
  );

  ipcMain.handle(
    IPC.onboardingMarkGlossaryTermSeen,
    async (_event, arg: { termId: string }): Promise<OnboardingTourProgress> => {
      const ctx = getCtx();
      if (!ctx.onboardingService) return emptyTourProgress();
      return ctx.onboardingService.markGlossaryTermSeen(arg?.termId ?? "");
    },
  );

  ipcMain.handle(
    IPC.onboardingResetTourProgress,
    async (_event, arg?: { tourId?: string }): Promise<OnboardingTourProgress> => {
      const ctx = getCtx();
      if (!ctx.onboardingService) return emptyTourProgress();
      return ctx.onboardingService.resetTourProgress(arg?.tourId);
    },
  );

  // Variant-aware tour progress (Round 2) ---------------------------------

  ipcMain.handle(
    IPC.onboardingMarkTourCompletedVariant,
    async (
      _event,
      arg: { tourId: string; variant: OnboardingTourVariant },
    ): Promise<OnboardingTourProgress> => {
      const ctx = getCtx();
      if (!ctx.onboardingService) return emptyTourProgress();
      return ctx.onboardingService.markTourCompleted(
        arg?.tourId ?? "",
        coerceVariant(arg?.variant),
      );
    },
  );

  ipcMain.handle(
    IPC.onboardingMarkTourDismissedVariant,
    async (
      _event,
      arg: { tourId: string; variant: OnboardingTourVariant },
    ): Promise<OnboardingTourProgress> => {
      const ctx = getCtx();
      if (!ctx.onboardingService) return emptyTourProgress();
      return ctx.onboardingService.markTourDismissed(
        arg?.tourId ?? "",
        coerceVariant(arg?.variant),
      );
    },
  );

  ipcMain.handle(
    IPC.onboardingUpdateTourStepVariant,
    async (
      _event,
      arg: { tourId: string; variant: OnboardingTourVariant; index: number },
    ): Promise<OnboardingTourProgress> => {
      const ctx = getCtx();
      if (!ctx.onboardingService) return emptyTourProgress();
      const index = typeof arg?.index === "number" ? arg.index : 0;
      return ctx.onboardingService.updateTourStep(
        arg?.tourId ?? "",
        coerceVariant(arg?.variant),
        index,
      );
    },
  );

  // Tutorial (Round 2) ----------------------------------------------------

  ipcMain.handle(IPC.onboardingTutorialStart, async (): Promise<OnboardingTourProgress> => {
    const ctx = getCtx();
    if (!ctx.onboardingService) return emptyTourProgress();
    return ctx.onboardingService.markTutorialStarted();
  });

  ipcMain.handle(
    IPC.onboardingTutorialDismiss,
    async (_event, arg?: { permanent?: boolean }): Promise<OnboardingTourProgress> => {
      const ctx = getCtx();
      if (!ctx.onboardingService) return emptyTourProgress();
      return ctx.onboardingService.markTutorialDismissed(Boolean(arg?.permanent));
    },
  );

  ipcMain.handle(IPC.onboardingTutorialComplete, async (): Promise<OnboardingTourProgress> => {
    const ctx = getCtx();
    if (!ctx.onboardingService) return emptyTourProgress();
    return ctx.onboardingService.markTutorialCompleted();
  });

  ipcMain.handle(
    IPC.onboardingTutorialUpdateAct,
    async (
      _event,
      arg: { actIndex: number; ctxSnapshot?: Record<string, unknown> },
    ): Promise<OnboardingTourProgress> => {
      const ctx = getCtx();
      if (!ctx.onboardingService) return emptyTourProgress();
      const actIndex = typeof arg?.actIndex === "number" ? arg.actIndex : 0;
      const snapshot =
        arg?.ctxSnapshot && typeof arg.ctxSnapshot === "object" && !Array.isArray(arg.ctxSnapshot)
          ? arg.ctxSnapshot
          : undefined;
      return ctx.onboardingService.updateTutorialAct(actIndex, snapshot);
    },
  );

  ipcMain.handle(
    IPC.onboardingTutorialSetSilenced,
    async (_event, arg: { silenced: boolean }): Promise<OnboardingTourProgress> => {
      const ctx = getCtx();
      if (!ctx.onboardingService) return emptyTourProgress();
      return ctx.onboardingService.setTutorialSilenced(Boolean(arg?.silenced));
    },
  );

  ipcMain.handle(
    IPC.onboardingTutorialClearSessionDismissal,
    async (): Promise<OnboardingTourProgress> => {
      const ctx = getCtx();
      if (!ctx.onboardingService) return emptyTourProgress();
      return ctx.onboardingService.clearTutorialSessionDismissal();
    },
  );

  ipcMain.handle(IPC.onboardingTutorialShouldPrompt, async (): Promise<boolean> => {
    const ctx = getCtx();
    if (!ctx.onboardingService) return false;
    return ctx.onboardingService.shouldPromptTutorial();
  });

  ipcMain.handle(IPC.automationsList, async (): Promise<AutomationRuleSummary[]> => {
    const ctx = getCtx();
    return ctx.automationService.list();
  });

  ipcMain.handle(IPC.automationsToggle, async (_event, arg: { id: string; enabled: boolean }): Promise<AutomationRuleSummary[]> => {
    const ctx = getCtx();
    return ctx.automationService.toggle({ id: arg?.id ?? "", enabled: Boolean(arg?.enabled) });
  });

  ipcMain.handle(IPC.automationsDeleteRule, async (_event, arg: { id: string }): Promise<AutomationRuleSummary[]> => {
    const ctx = getCtx();
    return ctx.automationService.deleteRule({ id: arg?.id ?? "" });
  });

  ipcMain.handle(IPC.automationsTriggerManually, async (_event, arg: AutomationManualTriggerRequest): Promise<AutomationRun> => {
    const ctx = getCtx();
    return await ctx.automationService.triggerManually({
      id: arg?.id ?? "",
      laneId: arg?.laneId ?? null,
      reviewProfileOverride: arg?.reviewProfileOverride ?? null,
      verboseTrace: Boolean(arg?.verboseTrace),
      dryRun: Boolean(arg?.dryRun),
    });
  });

  ipcMain.handle(IPC.automationsGetHistory, async (_event, arg: { id: string; limit?: number }): Promise<AutomationRun[]> => {
    const ctx = getCtx();
    return ctx.automationService.getHistory({ id: arg?.id ?? "", limit: arg?.limit });
  });

  ipcMain.handle(IPC.automationsListRuns, async (_event, arg: AutomationRunListArgs = {}): Promise<AutomationRun[]> => {
    const ctx = getCtx();
    return ctx.automationService.listRuns(arg);
  });

  ipcMain.handle(IPC.automationsGetRunDetail, async (_event, arg: { runId: string }): Promise<AutomationRunDetail | null> => {
    const ctx = getCtx();
    return ctx.automationService.getRunDetail({ runId: arg?.runId ?? "" });
  });

  ipcMain.handle(IPC.automationsGetIngressStatus, async (): Promise<AutomationIngressStatus> => {
    const ctx = getCtx();
    return ctx.automationService.getIngressStatus();
  });

  ipcMain.handle(IPC.automationsListIngressEvents, async (_event, arg: { limit?: number } | undefined): Promise<AutomationIngressEventRecord[]> => {
    const ctx = getCtx();
    return ctx.automationService.listIngressEvents(arg?.limit);
  });

  ipcMain.handle(IPC.automationsParseNaturalLanguage, async (_event, arg: AutomationParseNaturalLanguageRequest): Promise<AutomationParseNaturalLanguageResult> => {
    const ctx = getCtx();
    return await ctx.automationPlannerService.parseNaturalLanguage(arg);
  });

  ipcMain.handle(IPC.automationsValidateDraft, async (_event, arg: AutomationValidateDraftRequest): Promise<AutomationValidateDraftResult> => {
    const ctx = getCtx();
    return ctx.automationPlannerService.validateDraft(arg);
  });

  ipcMain.handle(IPC.automationsSaveDraft, async (_event, arg: AutomationSaveDraftRequest): Promise<AutomationSaveDraftResult> => {
    const ctx = getCtx();
    return ctx.automationPlannerService.saveDraft(arg);
  });

  ipcMain.handle(IPC.automationsSimulate, async (_event, arg: AutomationSimulateRequest): Promise<AutomationSimulateResult> => {
    const ctx = getCtx();
    return ctx.automationPlannerService.simulate(arg);
  });

  ipcMain.handle(IPC.reviewListLaunchContext, async (): Promise<ReviewLaunchContext> => {
    const ctx = getCtx();
    return ctx.reviewService.listLaunchContext();
  });

  ipcMain.handle(IPC.reviewListRuns, async (_event, arg: ReviewListRunsArgs = {}): Promise<ReviewRun[]> => {
    const ctx = getCtx();
    return ctx.reviewService.listRuns(arg);
  });

  ipcMain.handle(IPC.reviewGetRunDetail, async (_event, arg: { runId: string }): Promise<ReviewRunDetail | null> => {
    const ctx = getCtx();
    return ctx.reviewService.getRunDetail({ runId: arg?.runId ?? "" });
  });

  ipcMain.handle(IPC.reviewStartRun, async (_event, arg: ReviewStartRunArgs): Promise<ReviewRun> => {
    const ctx = getCtx();
    return ctx.reviewService.startRun(arg);
  });

  ipcMain.handle(IPC.reviewRerun, async (_event, arg: { runId: string }): Promise<ReviewRun> => {
    const ctx = getCtx();
    return ctx.reviewService.rerun(arg?.runId ?? "");
  });

  ipcMain.handle(IPC.reviewCancelRun, async (_event, arg: { runId: string }) => {
    const ctx = getCtx();
    return ctx.reviewService.cancelRun({ runId: arg?.runId ?? "" });
  });

  ipcMain.handle(IPC.reviewRecordFeedback, async (_event, arg: import("../../../shared/types").ReviewRecordFeedbackArgs) => {
    const ctx = getCtx();
    return ctx.reviewService.recordFeedback(arg);
  });

  ipcMain.handle(IPC.reviewListSuppressions, async (_event, arg: import("../../../shared/types").ReviewListSuppressionsArgs | undefined) => {
    const ctx = getCtx();
    return ctx.reviewService.listSuppressions(arg ?? {});
  });

  ipcMain.handle(IPC.reviewDeleteSuppression, async (_event, arg: { suppressionId: string }) => {
    const ctx = getCtx();
    return ctx.reviewService.deleteSuppression({ suppressionId: arg?.suppressionId ?? "" });
  });

  ipcMain.handle(IPC.reviewQualityReport, async () => {
    const ctx = getCtx();
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

  ipcMain.handle(IPC.missionsList, async (_event, arg: ListMissionsArgs = {}): Promise<MissionSummary[]> => {
    const ctx = getCtx();
    return ctx.missionService.list(arg);
  });

  ipcMain.handle(IPC.missionsGet, async (_event, arg: { missionId: string }): Promise<MissionDetail | null> => {
    const ctx = getCtx();
    return ctx.missionService.get(arg?.missionId ?? "");
  });

  ipcMain.handle(IPC.missionsListPhaseItems, async (_event, arg: ListPhaseItemsArgs = {}): Promise<PhaseCard[]> => {
    const ctx = getCtx();
    return ctx.missionService.listPhaseItems(arg);
  });

  ipcMain.handle(IPC.missionsSavePhaseItem, async (_event, arg: SavePhaseItemArgs): Promise<PhaseCard> => {
    const ctx = getCtx();
    return ctx.missionService.savePhaseItem(arg);
  });

  ipcMain.handle(IPC.missionsDeletePhaseItem, async (_event, arg: DeletePhaseItemArgs): Promise<void> => {
    const ctx = getCtx();
    ctx.missionService.deletePhaseItem(arg);
  });

  ipcMain.handle(IPC.missionsImportPhaseItems, async (_event, arg: ImportPhaseItemsArgs): Promise<PhaseCard[]> => {
    const ctx = getCtx();
    return ctx.missionService.importPhaseItems(arg);
  });

  ipcMain.handle(IPC.missionsExportPhaseItems, async (_event, arg: ExportPhaseItemsArgs = {}): Promise<ExportPhaseItemsResult> => {
    const ctx = getCtx();
    return ctx.missionService.exportPhaseItems(arg);
  });

  ipcMain.handle(IPC.missionsListPhaseProfiles, async (_event, arg: ListPhaseProfilesArgs = {}): Promise<PhaseProfile[]> => {
    const ctx = getCtx();
    return ctx.missionService.listPhaseProfiles(arg);
  });

  ipcMain.handle(IPC.missionsSavePhaseProfile, async (_event, arg: SavePhaseProfileArgs): Promise<PhaseProfile> => {
    const ctx = getCtx();
    return ctx.missionService.savePhaseProfile(arg);
  });

  ipcMain.handle(IPC.missionsDeletePhaseProfile, async (_event, arg: DeletePhaseProfileArgs): Promise<void> => {
    const ctx = getCtx();
    ctx.missionService.deletePhaseProfile(arg);
  });

  ipcMain.handle(IPC.missionsClonePhaseProfile, async (_event, arg: ClonePhaseProfileArgs): Promise<PhaseProfile> => {
    const ctx = getCtx();
    return ctx.missionService.clonePhaseProfile(arg);
  });

  ipcMain.handle(IPC.missionsExportPhaseProfile, async (_event, arg: ExportPhaseProfileArgs): Promise<ExportPhaseProfileResult> => {
    const ctx = getCtx();
    return ctx.missionService.exportPhaseProfile(arg);
  });

  ipcMain.handle(IPC.missionsImportPhaseProfile, async (_event, arg: ImportPhaseProfileArgs): Promise<PhaseProfile> => {
    const ctx = getCtx();
    return ctx.missionService.importPhaseProfile(arg);
  });

  ipcMain.handle(IPC.missionsGetPhaseConfiguration, async (_event, arg: { missionId: string }): Promise<MissionPhaseConfiguration | null> => {
    const ctx = getCtx();
    return ctx.missionService.getPhaseConfiguration(arg?.missionId ?? "");
  });

  ipcMain.handle(IPC.missionsGetDashboard, async (): Promise<MissionDashboardSnapshot> => {
    const ctx = getCtx();
    return ctx.missionService.getDashboard();
  });

  ipcMain.handle(
    IPC.missionsGetFullMissionView,
    async (_event, arg: GetFullMissionViewArgs): Promise<FullMissionViewResult> => {
      const ctx = getCtx();
      const missionId = typeof arg?.missionId === "string" ? arg.missionId.trim() : "";
      if (!missionId) return { mission: null, runGraph: null, artifacts: [], checkpoints: [], dashboard: null };

      let dashboard: MissionDashboardSnapshot | null = null;
      try {
        dashboard = ctx.missionService.getDashboard();
      } catch {
        /* best-effort */
      }

      const mission = await ctx.missionService.get(missionId);

      let runGraph: OrchestratorRunGraph | null = null;
      let artifacts: OrchestratorArtifact[] = [];
      let checkpoints: OrchestratorWorkerCheckpoint[] = [];

      const runs = await ctx.orchestratorService.listRuns({ missionId, limit: 20 });
      const activeStatuses = new Set(["active", "bootstrapping", "queued", "paused"]);
      const preferredRun = runs.find((entry) => activeStatuses.has(entry.status)) ?? runs[0];
      if (preferredRun) {
        const [graph, arts, cps] = await Promise.all([
          ctx.orchestratorService.getRunGraph({ runId: preferredRun.id, timelineLimit: 120 }),
          Promise.resolve().then(() => ctx.aiOrchestratorService.listArtifacts({ missionId, runId: preferredRun.id })).catch(() => []),
          Promise.resolve().then(() => ctx.aiOrchestratorService.listWorkerCheckpoints({ missionId, runId: preferredRun.id })).catch(() => []),
        ]);
        runGraph = compactRunGraphForTransport(graph);
        artifacts = Array.isArray(arts) ? arts : [];
        checkpoints = Array.isArray(cps) ? cps : [];
      }

      return { mission, runGraph, artifacts, checkpoints, dashboard };
    },
  );

  ipcMain.handle(IPC.missionsPreflight, async (_event, arg: MissionPreflightRequest): Promise<MissionPreflightResult> => {
    const ctx = getCtx();
    return await ctx.missionPreflightService.runPreflight(arg);
  });

  ipcMain.handle(IPC.missionsGetRunView, async (_event, arg: GetMissionRunViewArgs): Promise<MissionRunView | null> => {
    const ctx = getCtx();
    return await ctx.aiOrchestratorService.getRunView(arg);
  });

  ipcMain.handle(IPC.missionsCreate, async (_event, arg: CreateMissionArgs): Promise<MissionDetail> => {
    const ctx = getCtx();
    const prompt = typeof arg?.prompt === "string" ? arg.prompt.trim() : "";
    if (!prompt.length) throw new Error("Mission prompt is required.");
    const plannerEngine = arg?.plannerEngine ?? "auto";
    const autostart = arg?.autostart !== false;
    const runMode = arg?.launchMode === "manual" ? "manual" : "autopilot";
    const defaultExecutorKind: OrchestratorExecutorKind = runMode === "manual"
      ? "manual"
      : normalizeAutopilotExecutor(arg?.autopilotExecutor ?? "opencode");

    // Fast-path for autostart missions: create immediately and launch in the background
    // so renderer IPC does not block on planning/launch work.
    if (autostart) {
      const created = ctx.missionService.create({
        ...arg,
        launchMode: runMode,
        autostart: true,
        autopilotExecutor: defaultExecutorKind
      });

      void (async () => {
        try {
          await ctx.aiOrchestratorService.startMissionRun({
            missionId: created.id,
            runMode,
            autopilotOwnerId: "missions-autopilot",
            defaultExecutorKind,
            defaultRetryLimit: 1,
            metadata: {
              launchSource: "missions.create.fast_path",
              plannerEngineRequested: plannerEngine,
              plannerExecutorPolicy: "codex"
            }
          });
        } catch (error) {
          const message = getErrorMessage(error);
          const errorRecord = error as unknown as Record<string, unknown>;
          const launchFailure = error instanceof Error && isRecord(errorRecord.missionLaunchFailure)
            ? (errorRecord.missionLaunchFailure as Record<string, unknown>)
            : null;
          ctx.logger.warn("missions.autostart_failed", {
            missionId: created.id,
            runMode,
            defaultExecutorKind,
            error: message,
            failureStage: typeof launchFailure?.failureStage === "string" ? launchFailure.failureStage : null,
            runId: typeof launchFailure?.runId === "string" ? launchFailure.runId : null,
            rootErrorStack: typeof launchFailure?.rootErrorStack === "string" ? launchFailure.rootErrorStack : null,
          });
          if (!launchFailure) {
            try {
              ctx.missionService.addIntervention({
                missionId: created.id,
                interventionType: "policy_block",
                title: "Mission launch requires action",
                body: `Automatic run launch failed: ${message}`,
                requestedAction: "Review planner/runtime configuration and retry the blocked step."
              });
            } catch {
              // ignore best-effort intervention creation
            }
          }
        }
      })();

      const detail = ctx.missionService.get(created.id);
      if (detail) return detail;
      return created;
    }

    // Pre-mission planner pipeline retired — coordinator builds the DAG at runtime.
    // Simply create the mission with empty steps (non-autostart path).
    const created = ctx.missionService.create({
      ...arg,
      launchMode: "manual",
      autostart: false,
    });
    const detail = ctx.missionService.get(created.id);
    if (detail) return detail;
    return created;
  });

  ipcMain.handle(IPC.missionsUpdate, async (_event, arg: UpdateMissionArgs): Promise<MissionDetail> => {
    const ctx = getCtx();
    const updated = ctx.missionService.update(arg);
    return updated;
  });

  ipcMain.handle(IPC.missionsArchive, async (_event, arg: ArchiveMissionArgs): Promise<void> => {
    const ctx = getCtx();
    ctx.missionService.archive(arg);
  });

  ipcMain.handle(IPC.missionsDelete, async (_event, arg: DeleteMissionArgs): Promise<void> => {
    const ctx = getCtx();
    ctx.missionService.delete(arg);
  });

  ipcMain.handle(IPC.missionsUpdateStep, async (_event, arg: UpdateMissionStepArgs): Promise<MissionStep> => {
    const ctx = getCtx();
    const updated = ctx.missionService.updateStep(arg);
    return updated;
  });

  ipcMain.handle(IPC.missionsAddArtifact, async (_event, arg: AddMissionArtifactArgs): Promise<MissionArtifact> => {
    const ctx = getCtx();
    const artifact = ctx.missionService.addArtifact(arg);
    return artifact;
  });

  ipcMain.handle(
    IPC.missionsAddIntervention,
    async (_event, arg: AddMissionInterventionArgs): Promise<MissionIntervention> => {
      const ctx = getCtx();
      const intervention = ctx.missionService.addIntervention(arg);
      return intervention;
    }
  );

  ipcMain.handle(
    IPC.missionsResolveIntervention,
    async (_event, arg: ResolveMissionInterventionArgs): Promise<MissionIntervention> => {
      const ctx = getCtx();
      const intervention = ctx.missionService.resolveIntervention(arg);
      return intervention;
    }
  );

  ipcMain.handle(IPC.orchestratorListRuns, async (_event, arg: ListOrchestratorRunsArgs = {}): Promise<OrchestratorRun[]> => {
    const ctx = getCtx();
    return ctx.orchestratorService.listRuns(arg).map(compactRunForTransport);
  });

  ipcMain.handle(IPC.orchestratorGetRunGraph, async (_event, arg: GetOrchestratorRunGraphArgs): Promise<OrchestratorRunGraph> => {
    const ctx = getCtx();
    return compactRunGraphForTransport(ctx.orchestratorService.getRunGraph(arg));
  });

  ipcMain.handle(
    IPC.orchestratorStartRun,
    async (_event, arg: StartOrchestratorRunArgs): Promise<{ run: OrchestratorRun; steps: OrchestratorStep[] }> => {
      const ctx = getCtx();
      const started = ctx.orchestratorService.startRun(arg);
      return { ...started, run: compactRunForTransport(started.run) };
    }
  );

  ipcMain.handle(
    IPC.orchestratorStartRunFromMission,
    async (_event, arg: StartOrchestratorRunFromMissionArgs): Promise<{ run: OrchestratorRun; steps: OrchestratorStep[] }> => {
      const ctx = getCtx();
      const started = await ctx.aiOrchestratorService.startMissionRun({
        missionId: arg.missionId,
        runMode: arg.runMode,
        autopilotOwnerId: arg.autopilotOwnerId,
        defaultExecutorKind: arg.defaultExecutorKind,
        defaultRetryLimit: arg.defaultRetryLimit,
        metadata: arg.metadata ?? null,
        plannerProvider: arg.plannerProvider ?? undefined
      });
      if (!started.started) {
        throw new Error("Mission run did not produce a runnable execution.");
      }
      return { ...started.started, run: compactRunForTransport(started.started.run) };
    }
  );

  ipcMain.handle(
    IPC.orchestratorStartAttempt,
    async (_event, arg: StartOrchestratorAttemptArgs): Promise<OrchestratorAttempt> => {
      const ctx = getCtx();
      return await ctx.orchestratorService.startAttempt(arg);
    }
  );

  ipcMain.handle(
    IPC.orchestratorCompleteAttempt,
    async (_event, arg: CompleteOrchestratorAttemptArgs): Promise<OrchestratorAttempt> => {
      const ctx = getCtx();
      return ctx.orchestratorService.completeAttempt(arg);
    }
  );

  ipcMain.handle(IPC.orchestratorTickRun, async (_event, arg: TickOrchestratorRunArgs): Promise<OrchestratorRun> => {
    const ctx = getCtx();
    return compactRunForTransport(ctx.orchestratorService.tick(arg));
  });

  ipcMain.handle(IPC.orchestratorPauseRun, async (_event, arg: PauseOrchestratorRunArgs): Promise<OrchestratorRun> => {
    const ctx = getCtx();
    return compactRunForTransport(ctx.orchestratorService.pauseRun({
      runId: arg.runId,
      reason: arg.reason ?? "Paused from Missions UI.",
    }));
  });

  ipcMain.handle(IPC.orchestratorResumeRun, async (_event, arg: ResumeOrchestratorRunArgs): Promise<OrchestratorRun> => {
    const ctx = getCtx();
    return compactRunForTransport(ctx.aiOrchestratorService.resumeRun(arg));
  });

  ipcMain.handle(IPC.orchestratorCancelRun, async (_event, arg: CancelOrchestratorRunArgs): Promise<OrchestratorRun> => {
    const ctx = getCtx();
    try {
      await ctx.aiOrchestratorService.cancelRunGracefully(arg);
    } catch (error) {
      ctx.logger.warn("ipc.orchestrator_cancel_graceful_failed", {
        runId: arg?.runId ?? null,
        error: getErrorMessage(error)
      });
      ctx.orchestratorService.cancelRun(arg);
    }
    const run = ctx.orchestratorService.listRuns({ limit: 1_000 }).find((entry) => entry.id === arg.runId);
    if (!run) throw new Error(`Run not found after cancellation: ${arg.runId}`);
    return compactRunForTransport(run);
  });

  ipcMain.handle(
    IPC.orchestratorCleanupTeamResources,
    async (_event, arg: CleanupOrchestratorTeamResourcesArgs): Promise<CleanupOrchestratorTeamResourcesResult> => {
      const ctx = getCtx();
      return await ctx.aiOrchestratorService.cleanupTeamResources(arg);
    }
  );

  ipcMain.handle(
    IPC.orchestratorHeartbeatClaims,
    async (_event, arg: HeartbeatOrchestratorClaimsArgs): Promise<number> => {
      const ctx = getCtx();
      return ctx.orchestratorService.heartbeatClaims(arg);
    }
  );

  ipcMain.handle(
    IPC.orchestratorListTimeline,
    async (_event, arg: ListOrchestratorTimelineArgs): Promise<OrchestratorTimelineEvent[]> => {
      const ctx = getCtx();
      return ctx.orchestratorService.listTimeline(arg);
    }
  );

  ipcMain.handle(
    IPC.orchestratorGetMissionLogs,
    async (_event, arg: GetMissionLogsArgs): Promise<GetMissionLogsResult> => {
      const ctx = getCtx();
      return await ctx.aiOrchestratorService.getMissionLogs(arg);
    }
  );

  ipcMain.handle(
    IPC.orchestratorExportMissionLogs,
    async (_event, arg: ExportMissionLogsArgs): Promise<ExportMissionLogsResult> => {
      const ctx = getCtx();
      return await ctx.aiOrchestratorService.exportMissionLogs(arg);
    }
  );

  ipcMain.handle(
    IPC.orchestratorGetGateReport,
    async (_event, arg: GetOrchestratorGateReportArgs = {}): Promise<OrchestratorGateReport> => {
      const ctx = getCtx();
      return ctx.orchestratorService.getLatestGateReport(arg);
    }
  );

  ipcMain.handle(
    IPC.orchestratorGetWorkerStates,
    async (_event, arg: GetOrchestratorWorkerStatesArgs): Promise<OrchestratorWorkerState[]> => {
      const ctx = getCtx();
      return ctx.aiOrchestratorService.getWorkerStates(arg);
    }
  );

  ipcMain.handle(
    IPC.orchestratorStartMissionRun,
    async (_event, arg: StartMissionRunWithAIArgs): Promise<StartMissionRunWithAIResult> => {
      const ctx = getCtx();
      const result = await ctx.aiOrchestratorService.startMissionRun(arg);
      return result.started
        ? { ...result, started: { ...result.started, run: compactRunForTransport(result.started.run) } }
        : result;
    }
  );

  ipcMain.handle(
    IPC.orchestratorSteerMission,
    async (_event, arg: SteerMissionArgs): Promise<SteerMissionResult> => {
      const ctx = getCtx();
      return ctx.aiOrchestratorService.steerMission(arg);
    }
  );

  ipcMain.handle(
    IPC.orchestratorGetModelCapabilities,
    async (): Promise<GetModelCapabilitiesResult> => {
      const ctx = getCtx();
      return ctx.aiOrchestratorService.getModelCapabilities();
    }
  );

  ipcMain.handle(
    IPC.orchestratorGetTeamMembers,
    async (_event, arg: GetTeamMembersArgs): Promise<OrchestratorTeamMember[]> => {
      const ctx = getCtx();
      return ctx.aiOrchestratorService.getTeamMembers({ runId: arg.runId });
    }
  );

  ipcMain.handle(
    IPC.orchestratorGetTeamRuntimeState,
    async (_event, arg: GetTeamRuntimeStateArgs): Promise<OrchestratorTeamRuntimeState | null> => {
      const ctx = getCtx();
      return ctx.orchestratorService.getRunState(arg.runId);
    }
  );

  ipcMain.handle(
    IPC.orchestratorFinalizeRun,
    async (_event, arg: FinalizeRunArgs): Promise<FinalizeRunResult> => {
      const ctx = getCtx();
      return ctx.orchestratorService.finalizeRun(arg);
    }
  );

  ipcMain.handle(
    IPC.orchestratorSendChat,
    async (_event, arg: SendOrchestratorChatArgs): Promise<OrchestratorChatMessage> => {
      const ctx = getCtx();
      return ctx.aiOrchestratorService.sendChat(arg);
    }
  );

  ipcMain.handle(
    IPC.orchestratorGetChat,
    async (_event, arg: GetOrchestratorChatArgs): Promise<OrchestratorChatMessage[]> => {
      const ctx = getCtx();
      return ctx.aiOrchestratorService.getChat(arg).map(compactChatMessageForTransport);
    }
  );

  ipcMain.handle(
    IPC.orchestratorListChatThreads,
    async (_event, arg: ListOrchestratorChatThreadsArgs): Promise<OrchestratorChatThread[]> => {
      const ctx = getCtx();
      return ctx.aiOrchestratorService.listChatThreads(arg);
    }
  );

  ipcMain.handle(
    IPC.orchestratorGetThreadMessages,
    async (_event, arg: GetOrchestratorThreadMessagesArgs): Promise<OrchestratorChatMessage[]> => {
      const ctx = getCtx();
      return ctx.aiOrchestratorService.getThreadMessages(arg).map(compactChatMessageForTransport);
    }
  );

  ipcMain.handle(
    IPC.orchestratorSendThreadMessage,
    async (_event, arg: SendOrchestratorThreadMessageArgs): Promise<OrchestratorChatMessage> => {
      const ctx = getCtx();
      return ctx.aiOrchestratorService.sendThreadMessage(arg);
    }
  );

  ipcMain.handle(
    IPC.orchestratorGetWorkerDigest,
    async (_event, arg: GetOrchestratorWorkerDigestArgs): Promise<OrchestratorWorkerDigest | null> => {
      const ctx = getCtx();
      return ctx.aiOrchestratorService.getWorkerDigest(arg);
    }
  );

  ipcMain.handle(
    IPC.orchestratorListWorkerDigests,
    async (_event, arg: ListOrchestratorWorkerDigestsArgs): Promise<OrchestratorWorkerDigest[]> => {
      const ctx = getCtx();
      return ctx.aiOrchestratorService.listWorkerDigests(arg);
    }
  );

  ipcMain.handle(
    IPC.orchestratorGetContextCheckpoint,
    async (_event, arg: GetOrchestratorContextCheckpointArgs): Promise<OrchestratorContextCheckpoint | null> => {
      const ctx = getCtx();
      return ctx.aiOrchestratorService.getContextCheckpoint(arg);
    }
  );

  ipcMain.handle(
    IPC.orchestratorListLaneDecisions,
    async (_event, arg: ListOrchestratorLaneDecisionsArgs): Promise<OrchestratorLaneDecision[]> => {
      const ctx = getCtx();
      return ctx.aiOrchestratorService.listLaneDecisions(arg);
    }
  );

  ipcMain.handle(
    IPC.orchestratorListArtifacts,
    async (_event, arg: ListOrchestratorArtifactsArgs): Promise<OrchestratorArtifact[]> => {
      const ctx = getCtx();
      return ctx.aiOrchestratorService.listArtifacts(arg);
    }
  );

  ipcMain.handle(
    IPC.orchestratorListWorkerCheckpoints,
    async (_event, arg: ListOrchestratorWorkerCheckpointsArgs): Promise<OrchestratorWorkerCheckpoint[]> => {
      const ctx = getCtx();
      return ctx.aiOrchestratorService.listWorkerCheckpoints(arg);
    }
  );

  ipcMain.handle(
    IPC.orchestratorGetPromptInspector,
    async (_event, arg: GetOrchestratorPromptInspectorArgs): Promise<OrchestratorPromptInspector> => {
      const ctx = getCtx();
      return ctx.aiOrchestratorService.getPromptInspector(arg);
    }
  );

  ipcMain.handle(
    IPC.orchestratorGetPlanningPromptPreview,
    async (_event, arg: GetPlanningPromptPreviewArgs): Promise<OrchestratorPromptInspector> => {
      const ctx = getCtx();
      return ctx.aiOrchestratorService.getPlanningPromptPreview(arg);
    }
  );

  ipcMain.handle(
    IPC.orchestratorGetMissionMetrics,
    async (_event, arg: GetMissionMetricsArgs): Promise<{ config: MissionMetricsConfig | null; samples: MissionMetricSample[] }> => {
      const ctx = getCtx();
      return ctx.aiOrchestratorService.getMissionMetrics(arg);
    }
  );

  ipcMain.handle(
    IPC.orchestratorGetMissionBudgetStatus,
    async (_event, arg: GetMissionBudgetStatusArgs): Promise<MissionBudgetSnapshot> => {
      const ctx = getCtx();
      return await ctx.missionBudgetService.getMissionBudgetStatus(arg);
    }
  );

  ipcMain.handle(
    IPC.orchestratorGetMissionBudgetTelemetry,
    async (_event, arg: GetMissionBudgetTelemetryArgs): Promise<MissionBudgetTelemetrySnapshot> => {
      const ctx = getCtx();
      return ctx.missionBudgetService.getMissionBudgetTelemetry(arg ?? {});
    }
  );

  ipcMain.handle(
    IPC.orchestratorSetMissionMetricsConfig,
    async (_event, arg: SetMissionMetricsConfigArgs): Promise<MissionMetricsConfig> => {
      const ctx = getCtx();
      return ctx.aiOrchestratorService.setMissionMetricsConfig(arg);
    }
  );

  ipcMain.handle(
    IPC.orchestratorGetExecutionPlanPreview,
    async (_event, arg: { runId: string }): Promise<ExecutionPlanPreview | null> => {
      const ctx = getCtx();
      return ctx.aiOrchestratorService.getExecutionPlanPreview(arg);
    }
  );

  ipcMain.handle(
    IPC.orchestratorGetMissionStateDocument,
    async (_event, arg: GetMissionStateDocumentArgs): Promise<MissionStateDocument | null> => {
      const ctx = getCtx();
      return ctx.aiOrchestratorService.getMissionStateDocument(arg);
    }
  );

  ipcMain.handle(
    IPC.orchestratorGetCheckpointStatus,
    async (
      _event,
      arg: { runId: string }
    ): Promise<{ savedAt: string; turnCount: number; compactionCount: number } | null> => {
      const ctx = getCtx();
      const runId = arg?.runId?.trim();
      if (!runId) return null;
      const checkpoint = await readCoordinatorCheckpoint(ctx.project.rootPath, runId);
      if (!checkpoint) return null;
      return {
        savedAt: checkpoint.savedAt,
        turnCount: checkpoint.turnCount,
        compactionCount: checkpoint.compactionCount
      };
    }
  );

  ipcMain.handle(
    IPC.orchestratorSendAgentMessage,
    async (_event, arg: SendAgentMessageArgs): Promise<OrchestratorChatMessage> => {
      const ctx = getCtx();
      return ctx.aiOrchestratorService.sendAgentMessage(arg);
    }
  );

  ipcMain.handle(
    IPC.orchestratorGetGlobalChat,
    async (_event, arg: GetGlobalChatArgs): Promise<OrchestratorChatMessage[]> => {
      const ctx = getCtx();
      return ctx.aiOrchestratorService.getGlobalChat(arg).map(compactChatMessageForTransport);
    }
  );

  ipcMain.handle(
    IPC.orchestratorDeliverMessage,
    async (_event, arg: DeliverMessageArgs): Promise<{ delivered: boolean; method: string }> => {
      const ctx = getCtx();
      return ctx.aiOrchestratorService.deliverMessageToAgent(arg);
    }
  );

  ipcMain.handle(
    IPC.orchestratorGetActiveAgents,
    async (_event, arg: GetActiveAgentsArgs): Promise<ActiveAgentInfo[]> => {
      const ctx = getCtx();
      return ctx.aiOrchestratorService.getActiveAgents(arg);
    }
  );

  ipcMain.handle(IPC.getAggregatedUsage, (_e, arg) => {
    const ctx = getCtx();
    return ctx.aiOrchestratorService.getAggregatedUsage(arg ?? {});
  });

  // ── Usage tracking + budget cap IPC ──────────────────────────
  ipcMain.handle(IPC.usageGetSnapshot, async (): Promise<UsageSnapshot | null> => {
    const ctx = getCtx();
    return ctx.usageTrackingService?.getUsageSnapshot() ?? null;
  });

  ipcMain.handle(IPC.usageRefresh, async (): Promise<UsageSnapshot | null> => {
    const ctx = getCtx();
    return (await ctx.usageTrackingService?.forceRefresh()) ?? null;
  });

  ipcMain.handle(
    IPC.usageCheckBudget,
    async (
      _event,
      arg: { scope: BudgetCapScope; scopeId?: string; provider: BudgetCapProvider }
    ): Promise<BudgetCheckResult> => {
      const ctx = getCtx();
      if (!ctx.budgetCapService) {
        return { allowed: true, warnings: [] };
      }
      return ctx.budgetCapService.checkBudget(arg.scope, arg.scopeId ?? "all", arg.provider);
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

  ipcMain.handle(IPC.layoutGet, async (_event, arg: { layoutId: string }): Promise<DockLayout | null> => {
    const ctx = getCtx();
    const key = `dock_layout:${arg.layoutId}`;
    const value = ctx.db.getJson<DockLayout>(key);
    return value;
  });

  ipcMain.handle(IPC.layoutSet, async (_event, arg: { layoutId: string; layout: DockLayout }): Promise<void> => {
    const ctx = getCtx();
    const key = `dock_layout:${arg.layoutId}`;
    const safe = clampLayout(arg.layout);
    ctx.db.setJson(key, safe);
    ctx.logger.debug("layout.set", { key, panels: Object.keys(safe).length });
  });

  ipcMain.handle(IPC.tilingTreeGet, async (_event, arg: { layoutId: string }): Promise<unknown> => {
    const ctx = getCtx();
    const key = `tiling_tree:${arg.layoutId}`;
    const value = ctx.db.getJson<unknown>(key);
    return value;
  });

  ipcMain.handle(IPC.tilingTreeSet, async (_event, arg: { layoutId: string; tree: unknown }): Promise<void> => {
    const ctx = getCtx();
    const key = `tiling_tree:${arg.layoutId}`;
    ctx.db.setJson(key, arg.tree);
    ctx.logger.debug("tilingTree.set", { key });
  });

  ipcMain.handle(IPC.graphStateGet, async (_event, arg: { projectId: string }): Promise<GraphPersistedState | null> => {
    const ctx = getCtx();
    const key = `graph_state:${arg.projectId}`;
    return ctx.db.getJson<GraphPersistedState>(key);
  });

  ipcMain.handle(IPC.graphStateSet, async (_event, arg: { projectId: string; state: GraphPersistedState }): Promise<void> => {
    const ctx = getCtx();
    const key = `graph_state:${arg.projectId}`;
    ctx.db.setJson(key, arg.state);
  });

  ipcMain.handle(IPC.lanesList, async (_event, arg: ListLanesArgs): Promise<LaneSummary[]> => {
    const ctx = getCtx();
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
    const ctx = getCtx();
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
    const ctx = getCtx();
    const lane = await ctx.laneService.create({
      name: arg.name,
      description: arg.description,
      parentLaneId: arg.parentLaneId,
      baseBranch: arg.baseBranch,
      branchName: arg.branchName,
      linearIssue: arg.linearIssue ?? null,
      runtimePlacement: arg.runtimePlacement,
    });
    await ensureLanePortLease(ctx, lane.id);
    notifyLaneCreated(ctx, lane);
    return lane;
  });

  ipcMain.handle(IPC.lanesCreateChild, async (_event, arg: CreateChildLaneArgs): Promise<LaneSummary> => {
    const ctx = getCtx();
    const lane = await ctx.laneService.createChild(arg);
    await ensureLanePortLease(ctx, lane.id);
    notifyLaneCreated(ctx, lane);
    return lane;
  });

  ipcMain.handle(IPC.lanesCreateFromUnstaged, async (_event, arg: CreateLaneFromUnstagedArgs): Promise<LaneSummary> => {
    const ctx = getCtx();
    const lane = await ctx.laneService.createFromUnstaged(arg);
    await ensureLanePortLease(ctx, lane.id);
    notifyLaneCreated(ctx, lane);
    return lane;
  });

  ipcMain.handle(IPC.lanesImportBranch, async (_event, arg: ImportBranchLaneArgs): Promise<LaneSummary> => {
    const ctx = getCtx();
    const lane = await ctx.laneService.importBranch(arg);
    await ensureLanePortLease(ctx, lane.id);
    notifyLaneCreated(ctx, lane);
    return lane;
  });

  ipcMain.handle(IPC.lanesPreviewBranchSwitch, async (_event, arg: LaneBranchSwitchArgs): Promise<LaneBranchSwitchPreview> => {
    const ctx = getCtx();
    return await ctx.laneService.previewBranchSwitch(arg);
  });

  ipcMain.handle(IPC.lanesSwitchBranch, async (_event, arg: LaneBranchSwitchArgs): Promise<LaneBranchSwitchResult> => {
    const ctx = getCtx();
    return await ctx.laneService.switchBranch(arg);
  });

  ipcMain.handle(IPC.lanesAttach, async (_event, arg: AttachLaneArgs): Promise<LaneSummary> => {
    const ctx = getCtx();
    const lane = await ctx.laneService.attach(arg);
    await ensureLanePortLease(ctx, lane.id);
    notifyLaneCreated(ctx, lane);
    return lane;
  });

  ipcMain.handle(IPC.lanesListUnregisteredWorktrees, async (): Promise<UnregisteredLaneCandidate[]> => {
    const ctx = getCtx();
    return ctx.laneService.listUnregisteredWorktrees();
  });

  ipcMain.handle(IPC.lanesAdoptAttached, async (_event, arg: AdoptAttachedLaneArgs): Promise<LaneSummary> => {
    const ctx = getCtx();
    const lane = await ctx.laneService.adoptAttached(arg);
    await ensureLanePortLease(ctx, lane.id);
    notifyLaneCreated(ctx, lane);
    return lane;
  });

  ipcMain.handle(IPC.lanesRename, async (_event, arg: RenameLaneArgs): Promise<void> => {
    const ctx = getCtx();
    ctx.laneService.rename(arg);
  });

  ipcMain.handle(IPC.lanesReparent, async (_event, arg: ReparentLaneArgs): Promise<ReparentLaneResult> => {
    const ctx = getCtx();
    return await ctx.laneService.reparent(arg);
  });

  ipcMain.handle(IPC.lanesUpdateAppearance, async (_event, arg: UpdateLaneAppearanceArgs): Promise<void> => {
    const ctx = getCtx();
    ctx.laneService.updateAppearance(arg);
  });

  ipcMain.handle(IPC.lanesArchive, async (_event, arg: ArchiveLaneArgs): Promise<void> => {
    const ctx = getCtx();
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
    const ctx = getCtx();
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
    const ctx = getCtx();
    return ctx.laneService.cancelDelete(arg.laneId);
  });

  ipcMain.handle(IPC.lanesListDeleteProgress, async () => {
    const ctx = getCtx();
    return ctx.laneService.listDeleteProgress();
  });

  ipcMain.handle(IPC.lanesGetDeleteRisk, async (_event, arg: { laneId: string }) => {
    const ctx = getCtx();
    return await ctx.laneService.getDeleteRisk(arg.laneId);
  });

  ipcMain.handle(IPC.lanesGetStackChain, async (_event, arg: { laneId: string }): Promise<StackChainItem[]> => {
    const ctx = getCtx();
    return await ctx.laneService.getStackChain(arg.laneId);
  });

  ipcMain.handle(IPC.lanesGetChildren, async (_event, arg: { laneId: string }): Promise<LaneSummary[]> => {
    const ctx = getCtx();
    return await ctx.laneService.getChildren(arg.laneId);
  });

  ipcMain.handle(IPC.lanesRebaseStart, async (_event, arg: RebaseStartArgs): Promise<RebaseStartResult> => {
    const ctx = getCtx();
    return await ctx.laneService.rebaseStart(arg);
  });

  ipcMain.handle(IPC.lanesRebasePush, async (_event, arg: RebasePushArgs): Promise<RebaseRun> => {
    const ctx = getCtx();
    return await ctx.laneService.rebasePush(arg);
  });

  ipcMain.handle(IPC.lanesRebaseRollback, async (_event, arg: RebaseRollbackArgs): Promise<RebaseRun> => {
    const ctx = getCtx();
    return await ctx.laneService.rebaseRollback(arg);
  });

  ipcMain.handle(IPC.lanesRebaseAbort, async (_event, arg: RebaseAbortArgs): Promise<RebaseRun> => {
    const ctx = getCtx();
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

  ipcMain.handle(IPC.lanesOpenFolder, async (_event, arg: { laneId: string }): Promise<void> => {
    const ctx = getCtx();
    const worktreePath = ctx.laneService.getLaneWorktreePath(arg.laneId);
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
    const ctx = getCtx();
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
    const ctx = getCtx();
    if (!ctx.portAllocationService) return [];
    const lanes = await ctx.laneService.list({ includeArchived: false, includeStatus: false });
    const validIds = new Set(lanes.map((l) => l.id));
    return ctx.portAllocationService.recoverOrphans(validIds);
  });

  // --- Per-Lane Hostname Isolation & Preview (Phase 5 W4) --------------------

  const ensureLanePreviewInfo = async (laneId: string) => {
    const ctx = getCtx();
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
    const ctx = getCtx();
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
    return { sessionId: record.sessionId.trim(), steerId: record.steerId.trim() };
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

  ipcMain.handle(IPC.sessionsList, async (_event, arg: ListSessionsArgs): Promise<TerminalSessionSummary[]> => {
    const ctx = getCtx();
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
            await ctx.ptyService.ensureResumeTargets(missingResumeTargetIds);
            listedSessions = ctx.sessionService.list(arg);
          } catch (err) {
            ctx.logger.warn("sessions.resume_target_hydration_failed", {
              sessionIds: missingResumeTargetIds,
              err: String(err),
            });
          }
        }
        let sessions = ctx.ptyService.enrichSessions(listedSessions);
        const laneId = typeof arg?.laneId === "string" ? arg.laneId.trim() : "";
        let allChats: AgentChatSessionSummary[] = [];
        try {
          allChats = await ctx.agentChatService.listSessions(laneId || undefined, { includeIdentity: true });
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
          if (session.status !== "running") return session;
          const chat = chatSummaryBySessionId.get(session.id);
          if (!chat) return session;
          if (chat.awaitingInput) return { ...session, runtimeState: "waiting-input" as const, chatIdleSinceAt: null };
          if (chat.status === "active") return { ...session, runtimeState: "running" as const, chatIdleSinceAt: null };
          if (chat.status === "idle") return { ...session, runtimeState: "idle" as const, chatIdleSinceAt: chat.idleSinceAt ?? null };
          return session;
        });
      },
      {
        laneId: typeof arg?.laneId === "string" ? arg.laneId : null,
        limit: typeof arg?.limit === "number" ? arg.limit : null
      }
    );
  });

  ipcMain.handle(IPC.sessionsGet, async (_event, arg: { sessionId: string }): Promise<TerminalSessionDetail | null> => {
    const ctx = getCtx();
    let session = ctx.sessionService.get(arg.sessionId);
    if (!session) return null;
    if (sessionNeedsResumeTargetHydration(session)) {
      const sessionId = session.id;
      try {
        await ctx.ptyService.ensureResumeTargets([sessionId]);
        const hydratedSession = ctx.sessionService.get(arg.sessionId);
        if (hydratedSession) session = hydratedSession;
      } catch (err) {
        ctx.logger.warn("sessions.resume_target_hydration_failed", {
          sessionIds: [sessionId],
          err: String(err),
        });
      }
    }
    return ctx.ptyService.enrichSessions([session])[0] ?? {
      ...session,
      runtimeState: ctx.ptyService.getRuntimeState(session.id, session.status)
    };
  });

  ipcMain.handle(IPC.sessionsDelete, async (_event, arg: DeleteSessionArgs): Promise<void> => {
    const ctx = getCtx();
    const sessionId = typeof arg?.sessionId === "string" ? arg.sessionId.trim() : "";
    if (!sessionId) {
      throw new Error("Session id is required.");
    }
    const session = ctx.sessionService.get(sessionId);
    if (!session) {
      throw new Error(`Session '${sessionId}' was not found.`);
    }
    if (isChatToolType(session.toolType)) {
      throw new Error(`Session '${sessionId}' is an agent chat session. Use the chat delete flow instead.`);
    }
    if (session.status === "running" || session.ptyId) {
      throw new Error("Running terminal sessions must be closed before they can be deleted.");
    }
    ctx.sessionService.deleteSession(sessionId);
  });

  ipcMain.handle(IPC.sessionsUpdateMeta, async (_event, arg: UpdateSessionMetaArgs): Promise<TerminalSessionSummary | null> => {
    const ctx = getCtx();
    return ctx.sessionService.updateMeta(arg);
  });

  ipcMain.handle(IPC.sessionsReadTranscriptTail, async (_event, arg: { sessionId: string; maxBytes?: number; raw?: boolean }): Promise<string> => {
    const ctx = getCtx();
    const session = ctx.sessionService.get(arg.sessionId);
    if (!session) return "";
    const maxBytes = typeof arg.maxBytes === "number" ? Math.max(1024, Math.min(16_000_000, arg.maxBytes)) : 160_000;
    const raw = arg.raw === true;
    return ctx.ptyService.readTranscriptTail({
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

  ipcMain.handle(IPC.agentChatList, async (_event, arg: AgentChatListArgs = {}): Promise<AgentChatSessionSummary[]> => {
    const ctx = getCtx();
    const laneId = typeof arg?.laneId === "string" ? arg.laneId.trim() : "";
    return ctx.agentChatService.listSessions(laneId || undefined, { includeAutomation: Boolean(arg?.includeAutomation) });
  });

  ipcMain.handle(IPC.agentChatGetSummary, async (_event, arg: AgentChatGetSummaryArgs): Promise<AgentChatSessionSummary | null> => {
    const ctx = getCtx();
    return await ctx.agentChatService.getSessionSummary(arg?.sessionId ?? "");
  });

  ipcMain.handle(IPC.agentChatCreate, async (_event, arg: AgentChatCreateArgs): Promise<AgentChatSession> => {
    const ctx = getCtx();
    return await ctx.agentChatService.createSession(arg);
  });

  ipcMain.handle(IPC.agentChatSuggestLaneName, async (_event, arg: unknown): Promise<string> => {
    const ctx = getCtx();
    return await ctx.agentChatService.suggestLaneNameFromPrompt(parseAgentChatSuggestLaneNameArgs(arg));
  });

  ipcMain.handle(IPC.agentChatParallelLaunchStateGet, async (_event, arg: unknown): Promise<AgentChatParallelLaunchState | null> => {
    const ctx = getCtx();
    const { projectRoot, parentLaneId } = parseAgentChatParallelLaunchStateArgs(arg);
    const key = agentChatParallelLaunchStateKey(projectRoot, parentLaneId);
    return normalizeAgentChatParallelLaunchState(
      ctx.db.getJson<AgentChatParallelLaunchState | null>(key),
      parentLaneId,
    );
  });

  ipcMain.handle(IPC.agentChatParallelLaunchStateSet, async (_event, arg: AgentChatSetParallelLaunchStateArgs): Promise<void> => {
    const ctx = getCtx();
    const { projectRoot, parentLaneId } = parseAgentChatParallelLaunchStateArgs(arg);
    const key = agentChatParallelLaunchStateKey(projectRoot, parentLaneId);
    const nextState = normalizeAgentChatParallelLaunchState(arg?.state ?? null, parentLaneId);
    ctx.db.setJson(key, nextState);
  });

  ipcMain.handle(IPC.agentChatHandoff, async (_event, arg: AgentChatHandoffArgs): Promise<AgentChatHandoffResult> => {
    const ctx = getCtx();
    return await ctx.agentChatService.handoffSession(arg);
  });

  ipcMain.handle(IPC.agentChatSend, async (_event, arg: AgentChatSendArgs): Promise<void> => {
    const ctx = getCtx();
    await ctx.agentChatService.sendMessage(arg, { awaitDispatch: true });
  });

  ipcMain.handle(IPC.agentChatSteer, async (_event, arg: AgentChatSteerArgs): Promise<AgentChatSteerResult> => {
    const ctx = getCtx();
    return await ctx.agentChatService.steer(arg);
  });

  ipcMain.handle(IPC.agentChatCancelSteer, async (_event, arg: unknown): Promise<void> => {
    const ctx = getCtx();
    await ctx.agentChatService.cancelSteer(parseAgentChatCancelSteerArgs(arg));
  });

  ipcMain.handle(IPC.agentChatEditSteer, async (_event, arg: unknown): Promise<void> => {
    const ctx = getCtx();
    await ctx.agentChatService.editSteer(parseAgentChatEditSteerArgs(arg));
  });

  ipcMain.handle(IPC.agentChatDispatchSteer, async (_event, arg: unknown): Promise<AgentChatDispatchSteerResult> => {
    const ctx = getCtx();
    return await ctx.agentChatService.dispatchSteer(parseAgentChatDispatchSteerArgs(arg));
  });

  ipcMain.handle(IPC.agentChatCancelDispatchedSteer, async (_event, arg: unknown): Promise<AgentChatCancelDispatchedSteerResult> => {
    const ctx = getCtx();
    return await ctx.agentChatService.cancelDispatchedSteer(parseAgentChatCancelDispatchedSteerArgs(arg));
  });

  ipcMain.handle(IPC.agentChatInterrupt, async (_event, arg: AgentChatInterruptArgs): Promise<void> => {
    const ctx = getCtx();
    await ctx.agentChatService.interrupt(arg);
  });

  ipcMain.handle(IPC.agentChatApprove, async (_event, arg: AgentChatApproveArgs): Promise<void> => {
    const ctx = getCtx();
    await ctx.agentChatService.approveToolUse(arg);
  });

  ipcMain.handle(IPC.agentChatRespondToInput, async (_event, arg: AgentChatRespondToInputArgs): Promise<void> => {
    const ctx = getCtx();
    await ctx.agentChatService.respondToInput(arg);
  });

  ipcMain.handle(IPC.agentChatModels, async (_event, arg: AgentChatModelsArgs): Promise<AgentChatModelInfo[]> => {
    const ctx = getCtx();
    return await ctx.agentChatService.getAvailableModels(arg);
  });

  ipcMain.handle(IPC.agentChatModelCatalog, async (_event, arg: unknown) => {
    const ctx = getCtx();
    return await ctx.agentChatService.getModelCatalog(arg && typeof arg === "object" ? arg as never : undefined);
  });

  ipcMain.handle(IPC.agentChatArchive, async (_event, arg: AgentChatArchiveArgs): Promise<void> => {
    const ctx = getCtx();
    await ctx.agentChatService.archiveSession(arg);
  });

  ipcMain.handle(IPC.agentChatUnarchive, async (_event, arg: AgentChatArchiveArgs): Promise<void> => {
    const ctx = getCtx();
    await ctx.agentChatService.unarchiveSession(arg);
  });

  ipcMain.handle(IPC.agentChatDelete, async (_event, arg: AgentChatDeleteArgs): Promise<void> => {
    const ctx = getCtx();
    await ctx.agentChatService.deleteSession(arg);
  });

  ipcMain.handle(IPC.agentChatUpdateSession, async (_event, arg: AgentChatUpdateSessionArgs): Promise<AgentChatSession> => {
    const ctx = getCtx();
    return await ctx.agentChatService.updateSession(arg);
  });

  ipcMain.handle(IPC.agentChatWarmupModel, async (_event, arg: { sessionId: string; modelId: string }): Promise<void> => {
    const ctx = getCtx();
    return ctx.agentChatService.warmupModel(arg);
  });

  ipcMain.handle(IPC.agentChatSlashCommands, async (_event, arg: AgentChatSlashCommandsArgs): Promise<AgentChatSlashCommand[]> => {
    const ctx = getCtx();
    return ctx.agentChatService.getSlashCommands(arg);
  });

  ipcMain.handle(IPC.agentChatListClaudePlugins, async (_event, arg: AgentChatClaudePluginsArgs = {}): Promise<AgentChatClaudePlugin[]> => {
    const ctx = getCtx();
    return ctx.agentChatService.listClaudePlugins(arg);
  });

  ipcMain.handle(IPC.agentChatReloadClaudePlugins, async (_event, arg: AgentChatReloadClaudePluginsArgs): Promise<AgentChatReloadClaudePluginsResult> => {
    const ctx = getCtx();
    return ctx.agentChatService.reloadClaudePlugins(arg);
  });

  ipcMain.handle(IPC.agentChatListClaudeOutputStyles, async (_event, arg: AgentChatClaudeOutputStylesArgs = {}): Promise<AgentChatClaudeOutputStyle[]> => {
    const ctx = getCtx();
    return ctx.agentChatService.listClaudeOutputStyles(arg);
  });

  ipcMain.handle(IPC.agentChatSetClaudeOutputStyle, async (_event, arg: AgentChatSetClaudeOutputStyleArgs): Promise<AgentChatSession> => {
    const ctx = getCtx();
    return await ctx.agentChatService.setClaudeOutputStyle(arg);
  });

  ipcMain.handle(IPC.agentChatListClaudeSessions, async (_event, arg: AgentChatClaudeSessionListArgs = {}): Promise<AgentChatClaudeSessionInfo[]> => {
    const ctx = getCtx();
    return ctx.agentChatService.listClaudeSessions(arg);
  });

  ipcMain.handle(IPC.agentChatGetClaudeSessionInfo, async (_event, arg: AgentChatClaudeSessionInfoArgs): Promise<AgentChatClaudeSessionInfo | null> => {
    const ctx = getCtx();
    return ctx.agentChatService.getClaudeSessionInfo(arg);
  });

  ipcMain.handle(IPC.agentChatGetClaudeSessionMessages, async (_event, arg: AgentChatClaudeSessionMessagesArgs): Promise<AgentChatClaudeSessionMessage[]> => {
    const ctx = getCtx();
    return ctx.agentChatService.getClaudeSessionMessages(arg);
  });

  ipcMain.handle(IPC.agentChatGetSubagentTranscript, async (_event, arg: AgentChatSubagentTranscriptArgs): Promise<AgentChatSubagentTranscriptMessage[] | null> => {
    const ctx = getCtx();
    return ctx.agentChatService.getSubagentTranscript(arg);
  });

  ipcMain.handle(IPC.agentChatGetContextUsage, async (_event, arg: AgentChatContextUsageArgs): Promise<AgentChatContextUsage | null> => {
    const ctx = getCtx();
    return ctx.agentChatService.getContextUsage(arg);
  });

  ipcMain.handle(IPC.agentChatRewindFiles, async (_event, arg: AgentChatRewindFilesArgs): Promise<AgentChatRewindFilesResult> => {
    const ctx = getCtx();
    return ctx.agentChatService.rewindFiles(arg);
  });

  ipcMain.handle(IPC.agentChatFileSearch, async (_event, arg: AgentChatFileSearchArgs): Promise<AgentChatFileSearchResult[]> => {
    const ctx = getCtx();
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
    const ctx = getCtx();
    return ctx.agentChatService.listSubagents(arg);
  });

  ipcMain.handle(IPC.agentChatGetSessionCapabilities, async (_event, arg: AgentChatSessionCapabilitiesArgs): Promise<AgentChatSessionCapabilities> => {
    const ctx = getCtx();
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
    // Only forward maxEvents when it is a finite positive number; the service
    // layer applies its own clamp but guarding here avoids ambiguous NaN/0
    // inputs from untrusted renderer IPC.
    const rawMaxEvents = typeof arg?.maxEvents === "number" ? arg.maxEvents : undefined;
    const maxEvents =
      rawMaxEvents != null && Number.isFinite(rawMaxEvents) && rawMaxEvents > 0
        ? rawMaxEvents
        : undefined;
    return ctx.agentChatService.getChatEventHistory(sessionId, maxEvents != null ? { maxEvents } : undefined);
  });

  ipcMain.handle(IPC.agentChatCodexOpenInCli, async (
    event,
    arg: AgentChatCodexOpenInCliArgs,
  ): Promise<AgentChatCodexOpenInCliResult> => {
    assertTrustedAppControlSender(event, IPC.agentChatCodexOpenInCli);
    if (arg?.mode === "new-window") {
      assertAppControlRateLimit(event, IPC.agentChatCodexOpenInCli, { windowMs: 10_000, max: 10 });
    }

    const ctx = getCtx();
    const sessionId = typeof arg?.sessionId === "string" ? arg.sessionId.trim() : "";
    const mode = arg?.mode === "new-window" ? "new-window" : "ade-terminal";
    if (!sessionId) {
      throw new Error("agentChat.codex.openInCli requires a sessionId");
    }
    if (!ctx.agentChatService) {
      throw new Error("Open in Codex CLI is unavailable until a project is loaded in this window.");
    }
    const resumeCtx = ctx.agentChatService.getCodexResumeContext(sessionId);
    if (!resumeCtx) {
      throw new Error(`No resumable Codex thread for session ${sessionId}`);
    }
    if (resumeCtx.provider !== "codex") {
      throw new Error("Open-in-CLI is only supported for Codex sessions");
    }
    if (resumeCtx.isMission) {
      throw new Error("Mission sessions cannot be resumed in Codex CLI (ephemeral CODEX_HOME)");
    }
    const resolved = resolveCodexExecutable();
    const strategy = await detectCodexResumeStrategy(resolved.path);
    const argv = buildResumeArgv(strategy, resumeCtx.threadId);
    const result: AgentChatCodexOpenInCliResult = {
      binary: resolved.path,
      argv,
      cwd: resumeCtx.laneWorktreePath,
      threadId: resumeCtx.threadId,
      copyThreadIdToClipboard: strategy.copyThreadIdToClipboard,
    };
    if (mode === "new-window") {
      spawnInNewTerminalWindow({
        binary: resolved.path,
        argv,
        cwd: resumeCtx.laneWorktreePath,
      });
      result.spawnedNewWindow = true;
    }
    return result;
  });

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
        return "Simulator.app is not running, so the live window stream cannot update. Launch the simulator from ADE again.";
      case "hidden":
        return "Simulator.app is hidden. macOS stops updating hidden window capture, so ADE's visual stream can freeze until Simulator is shown again.";
      case "minimized":
        return "Simulator.app is minimized. macOS stops updating minimized window capture, so ADE's visual stream can freeze until the window is restored.";
      case "no-window":
        return "Simulator.app is running but no simulator window is available for ADE to capture.";
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
      scheduleSimulatorParking(window);
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
    scheduleSimulatorParking(window);
  };

  ipcMain.handle(IPC.iosSimulatorLaunch, async (event, arg = {}) => {
    const result = await ensureIosSimulator().launch(arg);
    const keepSimulatorInBackgroundPayload = (arg as { keepSimulatorInBackground?: unknown } | null)?.keepSimulatorInBackground;
    const keepSimulatorInBackground = keepSimulatorInBackgroundPayload === undefined ? true : keepSimulatorInBackgroundPayload === true;
    if (!keepSimulatorInBackground) {
      const browserWindow = BrowserWindow.fromWebContents(event.sender);
      await prepareSimulatorWindowForCapture(browserWindow, { placeBehindAde: false });
      cleanupSimulatorParkingFollow?.();
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

  ipcMain.handle(IPC.iosSimulatorRenderPreview, async (_event, arg) => ensureIosSimulator().renderPreview(arg));

  ipcMain.handle(IPC.iosSimulatorOpenPreviewWorkspace, async (_event, arg = {}) =>
    ensureIosSimulator().openPreviewWorkspace(arg));

  ipcMain.handle(IPC.iosSimulatorStartStream, async (_event, arg = {}) => ensureIosSimulator().startStream(arg));

  ipcMain.handle(IPC.iosSimulatorStopStream, async () => ensureIosSimulator().stopStream());

  ipcMain.handle(IPC.iosSimulatorGetStreamStatus, async () => ensureIosSimulator().getStreamStatus());

  ipcMain.handle(IPC.iosSimulatorGetWindowState, async () => getSimulatorWindowState());

  ipcMain.handle(IPC.iosSimulatorListWindowSources, async (event) => {
    const status = await ensureIosSimulator().getStatus();
    if (!status.supported) return [];
    const browserWindow = BrowserWindow.fromWebContents(event.sender);
    const readSources = async () => desktopCapturer.getSources({
      types: ["window"],
      thumbnailSize: { width: 320, height: 320 },
    });
    if (status.activeSession) {
      await prepareSimulatorWindowForCapture(browserWindow, { placeBehindAde: true });
      followSimulatorWindowUnderAde(browserWindow);
      await new Promise((resolve) => setTimeout(resolve, 350));
    }
    let sources = await readSources();
    if (status.activeSession && !sources.some((source) => simulatorWindowName.test(source.name))) {
      await prepareSimulatorWindowForCapture(browserWindow, { placeBehindAde: true });
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

  ipcMain.handle(IPC.builtInBrowserGetStatus, async (event) => {
    guardBuiltInBrowserIpc(event, IPC.builtInBrowserGetStatus, { windowMs: 10_000, max: 120 });
    return ensureBuiltInBrowser().getStatus();
  });

  ipcMain.handle(IPC.builtInBrowserShowPanel, async (event, arg) => {
    guardBuiltInBrowserIpc(event, IPC.builtInBrowserShowPanel, { windowMs: 10_000, max: 80 });
    return ensureBuiltInBrowser().showPanel(parseBuiltInBrowserOpenPanelArgs(arg, IPC.builtInBrowserShowPanel));
  });

  ipcMain.handle(IPC.builtInBrowserSetBounds, async (event, arg) => {
    guardBuiltInBrowserIpc(event, IPC.builtInBrowserSetBounds, { windowMs: 10_000, max: 900 });
    return ensureBuiltInBrowser().setBounds(parseBuiltInBrowserBoundsArgs(arg, IPC.builtInBrowserSetBounds));
  });

  ipcMain.handle(IPC.builtInBrowserAttachWebview, async (event, arg) => {
    guardBuiltInBrowserIpc(event, IPC.builtInBrowserAttachWebview, { windowMs: 10_000, max: 120 });
    return ensureBuiltInBrowser().attachWebview(parseBuiltInBrowserAttachWebviewArgs(arg, IPC.builtInBrowserAttachWebview));
  });

  ipcMain.handle(IPC.builtInBrowserNavigate, async (event, arg) => {
    guardBuiltInBrowserIpc(event, IPC.builtInBrowserNavigate, { windowMs: 60_000, max: 40 });
    return ensureBuiltInBrowser().navigate(parseBuiltInBrowserNavigateArgs(arg, IPC.builtInBrowserNavigate));
  });

  ipcMain.handle(IPC.builtInBrowserCreateTab, async (event, arg) => {
    guardBuiltInBrowserIpc(event, IPC.builtInBrowserCreateTab, { windowMs: 60_000, max: 40 });
    return ensureBuiltInBrowser().createTab(parseBuiltInBrowserCreateTabArgs(arg, IPC.builtInBrowserCreateTab));
  });

  ipcMain.handle(IPC.builtInBrowserSwitchTab, async (event, arg) => {
    guardBuiltInBrowserIpc(event, IPC.builtInBrowserSwitchTab, { windowMs: 10_000, max: 120 });
    return ensureBuiltInBrowser().switchTab(parseBuiltInBrowserTabArgs(arg, IPC.builtInBrowserSwitchTab));
  });

  ipcMain.handle(IPC.builtInBrowserCloseTab, async (event, arg) => {
    guardBuiltInBrowserIpc(event, IPC.builtInBrowserCloseTab, { windowMs: 10_000, max: 80 });
    return ensureBuiltInBrowser().closeTab(parseBuiltInBrowserTabArgs(arg, IPC.builtInBrowserCloseTab));
  });

  ipcMain.handle(IPC.builtInBrowserReload, async (event) => {
    guardBuiltInBrowserIpc(event, IPC.builtInBrowserReload, { windowMs: 10_000, max: 60 });
    return ensureBuiltInBrowser().reload();
  });

  ipcMain.handle(IPC.builtInBrowserGoBack, async (event) => {
    guardBuiltInBrowserIpc(event, IPC.builtInBrowserGoBack, { windowMs: 10_000, max: 80 });
    return ensureBuiltInBrowser().goBack();
  });

  ipcMain.handle(IPC.builtInBrowserGoForward, async (event) => {
    guardBuiltInBrowserIpc(event, IPC.builtInBrowserGoForward, { windowMs: 10_000, max: 80 });
    return ensureBuiltInBrowser().goForward();
  });

  ipcMain.handle(IPC.builtInBrowserStop, async (event) => {
    guardBuiltInBrowserIpc(event, IPC.builtInBrowserStop, { windowMs: 10_000, max: 80 });
    return ensureBuiltInBrowser().stop();
  });

  ipcMain.handle(IPC.builtInBrowserStartInspect, async (event) => {
    guardBuiltInBrowserIpc(event, IPC.builtInBrowserStartInspect, { windowMs: 10_000, max: 40 });
    return ensureBuiltInBrowser().startInspect();
  });

  ipcMain.handle(IPC.builtInBrowserStopInspect, async (event) => {
    guardBuiltInBrowserIpc(event, IPC.builtInBrowserStopInspect, { windowMs: 10_000, max: 80 });
    return ensureBuiltInBrowser().stopInspect();
  });

  ipcMain.handle(IPC.builtInBrowserCaptureScreenshot, async (event) => {
    guardBuiltInBrowserIpc(event, IPC.builtInBrowserCaptureScreenshot, { windowMs: 10_000, max: 30 });
    return ensureBuiltInBrowser().captureScreenshot();
  });

  ipcMain.handle(IPC.builtInBrowserSelectPoint, async (event, arg) => {
    guardBuiltInBrowserIpc(event, IPC.builtInBrowserSelectPoint, { windowMs: 10_000, max: 80 });
    return ensureBuiltInBrowser().selectPoint(parseBuiltInBrowserSelectPointArgs(arg, IPC.builtInBrowserSelectPoint));
  });

  ipcMain.handle(IPC.builtInBrowserSelectCurrent, async (event) => {
    guardBuiltInBrowserIpc(event, IPC.builtInBrowserSelectCurrent, { windowMs: 10_000, max: 80 });
    return ensureBuiltInBrowser().selectCurrent();
  });

  ipcMain.handle(IPC.builtInBrowserClearSelection, async (event) => {
    guardBuiltInBrowserIpc(event, IPC.builtInBrowserClearSelection, { windowMs: 10_000, max: 80 });
    return ensureBuiltInBrowser().clearSelection();
  });

  ipcMain.handle(IPC.macosVmGetStatus, async (event, arg = {}): Promise<MacosVmStatus> => {
    guardMacosVmIpc(event, IPC.macosVmGetStatus, { windowMs: 10_000, max: 80 });
    return ensureMacosVm().getStatus(parseMacosVmStatusArgs(arg, IPC.macosVmGetStatus));
  });

  ipcMain.handle(IPC.macosVmProvision, async (event, arg): Promise<MacosVmRecord> => {
    requireMacosVmEnabledInProduction(IPC.macosVmProvision);
    guardMacosVmIpc(event, IPC.macosVmProvision, { windowMs: 60_000, max: 4 });
    return ensureMacosVm().provision(parseMacosVmProvisionArgs(arg, IPC.macosVmProvision));
  });

  ipcMain.handle(IPC.macosVmStart, async (event, arg): Promise<MacosVmRecord> => {
    requireMacosVmEnabledInProduction(IPC.macosVmStart);
    guardMacosVmIpc(event, IPC.macosVmStart, { windowMs: 60_000, max: 8 });
    return ensureMacosVm().start(parseMacosVmStartArgs(arg, IPC.macosVmStart));
  });

  ipcMain.handle(IPC.macosVmStop, async (event, arg): Promise<MacosVmRecord | null> => {
    requireMacosVmEnabledInProduction(IPC.macosVmStop);
    guardMacosVmIpc(event, IPC.macosVmStop, { windowMs: 60_000, max: 12 });
    return ensureMacosVm().stop(parseMacosVmStopArgs(arg, IPC.macosVmStop));
  });

  ipcMain.handle(IPC.macosVmDelete, async (event, arg): Promise<{ deleted: boolean; previous: MacosVmRecord | null }> => {
    requireMacosVmEnabledInProduction(IPC.macosVmDelete);
    guardMacosVmIpc(event, IPC.macosVmDelete, { windowMs: 60_000, max: 4 });
    const args = parseMacosVmDeleteArgs(arg, IPC.macosVmDelete);
    const service = getCtx().macosVmService;
    if (service) return service.delete(args);
    return deleteMacosVmFromProjectState({
      projectRoot: resolveMacosVmProjectRootForEvent(event),
      args,
    });
  });

  ipcMain.handle(IPC.macosVmGetAgentGuide, async (event, arg): Promise<MacosVmAgentGuide> => {
    guardMacosVmIpc(event, IPC.macosVmGetAgentGuide, { windowMs: 10_000, max: 40 });
    return ensureMacosVm().getAgentGuide(parseMacosVmAgentGuideArgs(arg, IPC.macosVmGetAgentGuide));
  });

  ipcMain.handle(IPC.macosVmFocusWindow, async (event, arg): Promise<MacosVmWindowTarget> => {
    requireMacosVmEnabledInProduction(IPC.macosVmFocusWindow);
    guardMacosVmIpc(event, IPC.macosVmFocusWindow, { windowMs: 10_000, max: 30 });
    return ensureMacosVm().focusWindow(parseMacosVmFocusWindowArgs(arg, IPC.macosVmFocusWindow));
  });

  ipcMain.handle(IPC.macosVmGetDisplaySession, async (event, arg): Promise<MacosVmDisplaySession> => {
    requireMacosVmEnabledInProduction(IPC.macosVmGetDisplaySession);
    guardMacosVmIpc(event, IPC.macosVmGetDisplaySession, { windowMs: 10_000, max: 30 });
    return ensureMacosVm().getDisplaySession(parseMacosVmDisplaySessionArgs(arg, IPC.macosVmGetDisplaySession));
  });

  ipcMain.handle(IPC.macosVmCaptureScreenshot, async (event, arg): Promise<MacosVmCaptureScreenshotResult> => {
    requireMacosVmEnabledInProduction(IPC.macosVmCaptureScreenshot);
    guardMacosVmIpc(event, IPC.macosVmCaptureScreenshot, { windowMs: 30_000, max: 20 });
    return ensureMacosVm().captureScreenshot(parseMacosVmCaptureScreenshotArgs(arg, IPC.macosVmCaptureScreenshot));
  });

  ipcMain.handle(IPC.macosVmSelectPoint, async (event, arg): Promise<MacosVmSelectPointResult> => {
    requireMacosVmEnabledInProduction(IPC.macosVmSelectPoint);
    guardMacosVmIpc(event, IPC.macosVmSelectPoint, { windowMs: 30_000, max: 40 });
    return ensureMacosVm().selectPoint(parseMacosVmSelectPointArgs(arg, IPC.macosVmSelectPoint));
  });

  ipcMain.handle(IPC.macosVmClick, async (event, arg): Promise<{ ok: true; window: MacosVmWindowTarget; x: number; y: number }> => {
    requireMacosVmEnabledInProduction(IPC.macosVmClick);
    guardMacosVmIpc(event, IPC.macosVmClick, { windowMs: 10_000, max: 80 });
    return ensureMacosVm().click(parseMacosVmClickArgs(arg, IPC.macosVmClick));
  });

  ipcMain.handle(IPC.macosVmTypeText, async (event, arg): Promise<{ ok: true; window: MacosVmWindowTarget }> => {
    requireMacosVmEnabledInProduction(IPC.macosVmTypeText);
    guardMacosVmIpc(event, IPC.macosVmTypeText, { windowMs: 10_000, max: 40 });
    return ensureMacosVm().typeText(parseMacosVmTypeTextArgs(arg, IPC.macosVmTypeText));
  });

  // ---------------------------------------------------------------------------
  // Singleton-VM onboarding handlers.
  //
  // These methods are now implemented on `macosVmService`, but the IPC surface
  // continues to runtime-check before invoking so a partially-initialized
  // service or stale build cannot reach a missing method. The narrow extension
  // interface below preserves compile-time argument checking (the previous
  // `Record<string, (...a: unknown[]) => unknown>` cast lost all type info).
  // ---------------------------------------------------------------------------
  type MacosVmExtensionService = NonNullable<AppContext["macosVmService"]> & {
    restart?: (args: MacosVmRestartArgs) => Promise<MacosVmRecord | null>;
    wipe?: (args: MacosVmWipeArgs) => Promise<MacosVmWipeResult>;
    installRuntime?: (args: MacosVmInstallRuntimeArgs) => Promise<MacosVmRuntimeInstallStatus>;
    setCredentials?: (args: MacosVmSetCredentialsArgs) => Promise<{ ok: true }>;
    getCredentials?: (args: MacosVmGetCredentialsArgs) => Promise<MacosVmStoredCredentialsSummary>;
    getStorageInfo?: () => Promise<MacosVmStorageInfo>;
  };

  const callMacosVmExtension = async <T>(
    methodName: keyof MacosVmExtensionService,
    invoke: (svc: MacosVmExtensionService) => Promise<T> | T,
  ): Promise<T> => {
    const svc = ensureMacosVm() as MacosVmExtensionService;
    if (typeof svc[methodName] !== "function") {
      throw new Error(`macosVmService.${String(methodName)} is not implemented yet`);
    }
    return invoke(svc);
  };

  ipcMain.handle(IPC.macosVmRestart, async (event, arg): Promise<MacosVmRecord | null> => {
    requireMacosVmEnabledInProduction(IPC.macosVmRestart);
    guardMacosVmIpc(event, IPC.macosVmRestart, { windowMs: 60_000, max: 6 });
    const args = parseMacosVmRestartArgs(arg, IPC.macosVmRestart);
    return callMacosVmExtension("restart", (svc) => svc.restart!(args));
  });

  ipcMain.handle(IPC.macosVmWipe, async (event, arg): Promise<MacosVmWipeResult> => {
    requireMacosVmEnabledInProduction(IPC.macosVmWipe);
    guardMacosVmIpc(event, IPC.macosVmWipe, { windowMs: 60_000, max: 2 });
    const args = parseMacosVmWipeArgs(arg, IPC.macosVmWipe);
    return callMacosVmExtension("wipe", (svc) => svc.wipe!(args));
  });

  ipcMain.handle(IPC.macosVmInstallRuntime, async (event, arg): Promise<MacosVmRuntimeInstallStatus> => {
    requireMacosVmEnabledInProduction(IPC.macosVmInstallRuntime);
    guardMacosVmIpc(event, IPC.macosVmInstallRuntime, { windowMs: 300_000, max: 4 });
    const args = parseMacosVmInstallRuntimeArgs(arg, IPC.macosVmInstallRuntime);
    return callMacosVmExtension("installRuntime", (svc) => svc.installRuntime!(args));
  });

  ipcMain.handle(IPC.macosVmSetCredentials, async (event, arg): Promise<{ ok: true }> => {
    requireMacosVmEnabledInProduction(IPC.macosVmSetCredentials);
    guardMacosVmIpc(event, IPC.macosVmSetCredentials, { windowMs: 60_000, max: 12 });
    const args = parseMacosVmSetCredentialsArgs(arg, IPC.macosVmSetCredentials);
    return callMacosVmExtension("setCredentials", (svc) => svc.setCredentials!(args));
  });

  ipcMain.handle(IPC.macosVmGetCredentials, async (event, arg): Promise<MacosVmStoredCredentialsSummary> => {
    requireMacosVmEnabledInProduction(IPC.macosVmGetCredentials);
    guardMacosVmIpc(event, IPC.macosVmGetCredentials, { windowMs: 10_000, max: 60 });
    const args = parseMacosVmGetCredentialsArgs(arg, IPC.macosVmGetCredentials);
    return callMacosVmExtension("getCredentials", (svc) => svc.getCredentials!(args));
  });

  ipcMain.handle(IPC.macosVmGetStorageInfo, async (event): Promise<MacosVmStorageInfo> => {
    guardMacosVmIpc(event, IPC.macosVmGetStorageInfo, { windowMs: 10_000, max: 30 });
    return callMacosVmExtension("getStorageInfo", (svc) => svc.getStorageInfo!());
  });

  ipcMain.handle(IPC.macosVmDetachLane, async (event, arg): Promise<MacosVmDetachLaneResult> => {
    requireMacosVmEnabledInProduction(IPC.macosVmDetachLane);
    guardMacosVmIpc(event, IPC.macosVmDetachLane, { windowMs: 60_000, max: 12 });
    const args = parseMacosVmDetachLaneArgs(arg, IPC.macosVmDetachLane);
    const laneService = getCtx().laneService as AppContext["laneService"] & {
      detachVmLane?: (a: MacosVmDetachLaneArgs) => Promise<MacosVmDetachLaneResult>;
    };
    if (typeof laneService.detachVmLane !== "function") {
      throw new Error("laneService.detachVmLane is not implemented yet");
    }
    return laneService.detachVmLane(args);
  });

  ipcMain.handle(IPC.ptyCreate, async (_event, arg: PtyCreateArgs): Promise<PtyCreateResult> => {
    const ctx = getCtx();
    return await ctx.ptyService.create(arg);
  });

  ipcMain.handle(IPC.ptySendToSession, async (_event, arg: PtySendToSessionArgs): Promise<PtySendToSessionResult> => {
    const ctx = getCtx();
    return await ctx.ptyService.sendToSession(arg);
  });

  ipcMain.handle(IPC.ptyWrite, async (_event, arg: { ptyId: string; data: string }): Promise<void> => {
    const ctx = getCtx();
    ctx.ptyService.write(arg);
  });

  ipcMain.handle(IPC.ptyResize, async (_event, arg: { ptyId: string; cols: number; rows: number }): Promise<void> => {
    const ctx = getCtx();
    ctx.ptyService.resize(arg);
  });

  ipcMain.handle(IPC.ptyDispose, async (_event, arg: { ptyId: string; sessionId?: string }): Promise<void> => {
    const ctx = getCtx();
    ctx.ptyService.dispose(arg);
  });

  ipcMain.handle(IPC.terminalList, async (_event, arg) =>
    getCtx().ptyService.listTerminals(parseTerminalListArgs(arg)),
  );

  ipcMain.handle(IPC.terminalRead, async (_event, arg) =>
    getCtx().ptyService.readTerminal(parseTerminalReadArgs(arg)),
  );

  ipcMain.handle(IPC.terminalPreview, async (_event, arg) =>
    getCtx().ptyService.previewTerminal(parseTerminalPreviewArgs(arg)),
  );

  ipcMain.handle(IPC.terminalWrite, async (_event, arg) =>
    await getCtx().ptyService.writeTerminal(parseTerminalWriteArgs(arg)),
  );

  ipcMain.handle(IPC.terminalSignal, async (_event, arg) =>
    getCtx().ptyService.signalTerminal(parseTerminalSignalArgs(arg)),
  );

  ipcMain.handle(IPC.terminalActiveForChat, async (_event, arg) =>
    getCtx().ptyService.activeForChat(parseTerminalActiveForChatArgs(arg)),
  );

  ipcMain.handle(IPC.terminalReattachChatCli, async (_event, arg) =>
    await getCtx().ptyService.reattachChatCli(parseTerminalReattachArgs(arg)),
  );

  ipcMain.handle(IPC.diffGetChanges, async (_event, arg: GetDiffChangesArgs) => {
    const ctx = getCtx();
    return await withIpcTiming(ctx, "diff.getChanges", async () => await ctx.diffService.getChanges(arg.laneId), {
      laneId: arg.laneId,
    });
  });

  ipcMain.handle(IPC.diffGetFile, async (_event, arg: GetFileDiffArgs) => {
    const ctx = getCtx();
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
    const ctx = getCtx();
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
    const ctx = getCtx();
    ctx.fileService.writeTextAtomic({ laneId: arg.laneId, relPath: arg.path, text: arg.text });
  });

  ipcMain.handle(IPC.filesListWorkspaces, async (_event, arg: FilesListWorkspacesArgs = {}): Promise<FilesWorkspace[]> => {
    const ctx = getCtx();
    return ctx.fileService.listWorkspaces(arg);
  });

  ipcMain.handle(IPC.filesListTree, async (_event, arg: FilesListTreeArgs): Promise<FileTreeNode[]> => {
    const ctx = getCtx();
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

  ipcMain.handle(IPC.filesReadFile, async (_event, arg: FilesReadFileArgs): Promise<FileContent> => {
    const ctx = getCtx();
    return await withIpcTiming(
      ctx,
      "files.readFile",
      async () => ctx.fileService.readFile(arg),
      {
        workspaceId: arg.workspaceId,
        pathLength: arg.path.length,
      }
    );
  });

  ipcMain.handle(IPC.filesWriteText, async (_event, arg: FilesWriteTextArgs): Promise<void> => {
    const ctx = getCtx();
    ctx.fileService.writeWorkspaceText(arg);
  });

  ipcMain.handle(IPC.filesCreateFile, async (_event, arg: FilesCreateFileArgs): Promise<void> => {
    const ctx = getCtx();
    ctx.fileService.createFile(arg);
  });

  ipcMain.handle(IPC.filesCreateDirectory, async (_event, arg: FilesCreateDirectoryArgs): Promise<void> => {
    const ctx = getCtx();
    ctx.fileService.createDirectory(arg);
  });

  ipcMain.handle(IPC.filesRename, async (_event, arg: FilesRenameArgs): Promise<void> => {
    const ctx = getCtx();
    ctx.fileService.rename(arg);
  });

  ipcMain.handle(IPC.filesDelete, async (_event, arg: FilesDeleteArgs): Promise<void> => {
    const ctx = getCtx();
    ctx.fileService.deletePath(arg);
  });

  ipcMain.handle(IPC.filesWatchChanges, async (event, arg: FilesWatchArgs): Promise<void> => {
    const ctx = getCtx();
    const senderId = event.sender.id;
    if (!watcherCleanupBoundSenders.has(senderId)) {
      watcherCleanupBoundSenders.add(senderId);
      event.sender.once("destroyed", () => {
        watcherCleanupBoundSenders.delete(senderId);
        try {
          getCtx().fileService.stopWatchingBySender(senderId);
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
    const ctx = getCtx();
    ctx.fileService.stopWatching(arg, event.sender.id);
  });

  ipcMain.handle(IPC.filesQuickOpen, async (_event, arg: FilesQuickOpenArgs): Promise<FilesQuickOpenItem[]> => {
    const ctx = getCtx();
    return await ctx.fileService.quickOpen(arg);
  });

  ipcMain.handle(IPC.filesSearchText, async (_event, arg: FilesSearchTextArgs): Promise<FilesSearchTextMatch[]> => {
    const ctx = getCtx();
    return await ctx.fileService.searchText(arg);
  });

  ipcMain.handle(IPC.gitStageFile, async (_event, arg: GitFileActionArgs): Promise<GitActionResult> => {
    const ctx = getCtx();
    return ctx.gitService.stageFile(arg);
  });

  ipcMain.handle(IPC.gitStageAll, async (_event, arg: GitBatchFileActionArgs): Promise<GitActionResult> => {
    const ctx = getCtx();
    return ctx.gitService.stageAll(arg);
  });

  ipcMain.handle(IPC.gitUnstageFile, async (_event, arg: GitFileActionArgs): Promise<GitActionResult> => {
    const ctx = getCtx();
    return ctx.gitService.unstageFile(arg);
  });

  ipcMain.handle(IPC.gitUnstageAll, async (_event, arg: GitBatchFileActionArgs): Promise<GitActionResult> => {
    const ctx = getCtx();
    return ctx.gitService.unstageAll(arg);
  });

  ipcMain.handle(IPC.gitDiscardFile, async (_event, arg: GitFileActionArgs): Promise<GitActionResult> => {
    const ctx = getCtx();
    return ctx.gitService.discardFile(arg);
  });

  ipcMain.handle(IPC.gitRestoreStagedFile, async (_event, arg: GitFileActionArgs): Promise<GitActionResult> => {
    const ctx = getCtx();
    return ctx.gitService.restoreStagedFile(arg);
  });

  ipcMain.handle(IPC.gitCommit, async (_event, arg: GitCommitArgs): Promise<GitActionResult> => {
    const ctx = getCtx();
    return ctx.gitService.commit(arg);
  });

  ipcMain.handle(
    IPC.gitGenerateCommitMessage,
    async (_event, arg: GitGenerateCommitMessageArgs): Promise<GitGenerateCommitMessageResult> => {
      const ctx = getCtx();
      return ctx.gitService.generateCommitMessage(arg);
    }
  );

  ipcMain.handle(IPC.gitListRecentCommits, async (_event, arg: { laneId: string; limit?: number }): Promise<GitCommitSummary[]> => {
    const ctx = getCtx();
    return ctx.gitService.listRecentCommits(arg);
  });

  ipcMain.handle(IPC.gitListCommitFiles, async (_event, arg: GitListCommitFilesArgs): Promise<string[]> => {
    const ctx = getCtx();
    return await ctx.gitService.listCommitFiles(arg);
  });

  ipcMain.handle(IPC.gitGetCommitMessage, async (_event, arg: GitGetCommitMessageArgs): Promise<string> => {
    const ctx = getCtx();
    return await ctx.gitService.getCommitMessage(arg);
  });

  ipcMain.handle(IPC.gitRevertCommit, async (_event, arg: GitRevertArgs): Promise<GitActionResult> => {
    const ctx = getCtx();
    return ctx.gitService.revertCommit(arg);
  });

  ipcMain.handle(IPC.gitCherryPickCommit, async (_event, arg: GitCherryPickArgs): Promise<GitActionResult> => {
    const ctx = getCtx();
    return ctx.gitService.cherryPickCommit(arg);
  });

  ipcMain.handle(IPC.gitStashPush, async (_event, arg: GitStashPushArgs): Promise<GitActionResult> => {
    const ctx = getCtx();
    return ctx.gitService.stashPush(arg);
  });

  ipcMain.handle(IPC.gitStashList, async (_event, arg: { laneId: string }): Promise<GitStashSummary[]> => {
    const ctx = getCtx();
    return ctx.gitService.listStashes(arg);
  });

  ipcMain.handle(IPC.gitStashApply, async (_event, arg: GitStashRefArgs): Promise<GitActionResult> => {
    const ctx = getCtx();
    return ctx.gitService.stashApply(arg);
  });

  ipcMain.handle(IPC.gitStashPop, async (_event, arg: GitStashRefArgs): Promise<GitActionResult> => {
    const ctx = getCtx();
    return ctx.gitService.stashPop(arg);
  });

  ipcMain.handle(IPC.gitStashDrop, async (_event, arg: GitStashRefArgs): Promise<GitActionResult> => {
    const ctx = getCtx();
    return ctx.gitService.stashDrop(arg);
  });

  ipcMain.handle(IPC.gitStashClear, async (_event, arg: { laneId: string }): Promise<GitActionResult> => {
    const ctx = getCtx();
    return ctx.gitService.stashClear(arg);
  });

  ipcMain.handle(IPC.gitFetch, async (_event, arg: { laneId: string }): Promise<GitActionResult> => {
    const ctx = getCtx();
    return ctx.gitService.fetch(arg);
  });

  ipcMain.handle(IPC.gitPull, async (_event, arg: { laneId: string }): Promise<GitActionResult> => {
    const ctx = getCtx();
    return ctx.gitService.pull(arg);
  });

  ipcMain.handle(IPC.gitGetSyncStatus, async (_event, arg: { laneId: string }): Promise<GitUpstreamSyncStatus> => {
    const ctx = getCtx();
    return await ctx.gitService.getSyncStatus(arg);
  });

  ipcMain.handle(IPC.gitGetOriginRemote, async (_event, arg: { laneId: string }): Promise<{ remoteUrl: string | null; branch: string | null }> => {
    const ctx = getCtx();
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
    const ctx = getCtx();
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
    const ctx = getCtx();
    return ctx.gitService.sync(arg);
  });

  ipcMain.handle(IPC.gitPush, async (_event, arg: GitPushArgs): Promise<GitActionResult> => {
    const ctx = getCtx();
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
    const ctx = getCtx();
    return await ctx.gitService.getConflictState({ laneId: arg?.laneId ?? "" });
  });

  ipcMain.handle(IPC.gitRebaseContinue, async (_event, arg: { laneId: string }): Promise<GitActionResult> => {
    const ctx = getCtx();
    return await ctx.gitService.rebaseContinue({ laneId: arg?.laneId ?? "" });
  });

  ipcMain.handle(IPC.gitRebaseAbort, async (_event, arg: { laneId: string }): Promise<GitActionResult> => {
    const ctx = getCtx();
    return await ctx.gitService.rebaseAbort({ laneId: arg?.laneId ?? "" });
  });

  ipcMain.handle(IPC.gitMergeContinue, async (_event, arg: { laneId: string }): Promise<GitActionResult> => {
    const ctx = getCtx();
    return await ctx.gitService.mergeContinue({ laneId: arg?.laneId ?? "" });
  });

  ipcMain.handle(IPC.gitMergeAbort, async (_event, arg: { laneId: string }): Promise<GitActionResult> => {
    const ctx = getCtx();
    return await ctx.gitService.mergeAbort({ laneId: arg?.laneId ?? "" });
  });

  ipcMain.handle(IPC.gitListBranches, async (_event, arg: GitListBranchesArgs): Promise<GitBranchSummary[]> => {
    const ctx = getCtx();
    return await ctx.gitService.listBranches(arg);
  });

  ipcMain.handle(IPC.gitGetUserIdentity, async (_event, arg: GitGetUserIdentityArgs): Promise<GitUserIdentity> => {
    const ctx = getCtx();
    return await ctx.gitService.getUserIdentity(arg);
  });

  ipcMain.handle(IPC.gitCheckoutBranch, async (_event, arg: GitCheckoutBranchArgs): Promise<GitActionResult> => {
    const ctx = getCtx();
    return await ctx.gitService.checkoutBranch(arg);
  });

  ipcMain.handle(IPC.conflictsGetLaneStatus, async (_event, arg: GetLaneConflictStatusArgs): Promise<ConflictStatus> => {
    const ctx = getCtx();
    return await ctx.conflictService.getLaneStatus(arg);
  });

  ipcMain.handle(IPC.conflictsListOverlaps, async (_event, arg: ListOverlapsArgs): Promise<ConflictOverlap[]> => {
    const ctx = getCtx();
    return await ctx.conflictService.listOverlaps(arg);
  });

  ipcMain.handle(IPC.conflictsGetRiskMatrix, async (): Promise<RiskMatrixEntry[]> => {
    const ctx = getCtx();
    return await ctx.conflictService.getRiskMatrix();
  });

  ipcMain.handle(IPC.conflictsSimulateMerge, async (_event, arg: MergeSimulationArgs): Promise<MergeSimulationResult> => {
    const ctx = getCtx();
    return await ctx.conflictService.simulateMerge(arg);
  });

  ipcMain.handle(IPC.conflictsRunPrediction, async (_event, arg: RunConflictPredictionArgs = {}): Promise<BatchAssessmentResult> => {
    const ctx = getCtx();
    return await ctx.conflictService.runPrediction(arg);
  });

  ipcMain.handle(IPC.conflictsGetBatchAssessment, async (): Promise<BatchAssessmentResult> => {
    const ctx = getCtx();
    return await ctx.conflictService.getBatchAssessment();
  });

  ipcMain.handle(IPC.conflictsListProposals, async (_event, arg: { laneId: string }): Promise<ConflictProposal[]> => {
    const ctx = getCtx();
    return await ctx.conflictService.listProposals(arg);
  });

  ipcMain.handle(IPC.conflictsPrepareProposal, async (_event, arg: PrepareConflictProposalArgs): Promise<ConflictProposalPreview> => {
    const ctx = getCtx();
    return await ctx.conflictService.prepareProposal(arg);
  });

  ipcMain.handle(IPC.conflictsRequestProposal, async (_event, arg: RequestConflictProposalArgs): Promise<ConflictProposal> => {
    const ctx = getCtx();
    return await ctx.conflictService.requestProposal(arg);
  });

  ipcMain.handle(IPC.conflictsApplyProposal, async (_event, arg: ApplyConflictProposalArgs): Promise<ConflictProposal> => {
    const ctx = getCtx();
    const updated = await ctx.conflictService.applyProposal(arg);
    ctx.jobEngine.runConflictPredictionNow({ laneId: arg.laneId });
    return updated;
  });

  ipcMain.handle(IPC.conflictsUndoProposal, async (_event, arg: UndoConflictProposalArgs): Promise<ConflictProposal> => {
    const ctx = getCtx();
    const updated = await ctx.conflictService.undoProposal(arg);
    ctx.jobEngine.runConflictPredictionNow({ laneId: arg.laneId });
    return updated;
  });

  ipcMain.handle(IPC.conflictsRunExternalResolver, async (_event, arg: RunExternalConflictResolverArgs): Promise<ConflictExternalResolverRunSummary> => {
    const ctx = getCtx();
    return await ctx.conflictService.runExternalResolver(arg);
  });

  ipcMain.handle(IPC.conflictsListExternalResolverRuns, async (_event, arg: ListExternalConflictResolverRunsArgs = {}): Promise<ConflictExternalResolverRunSummary[]> => {
    const ctx = getCtx();
    return ctx.conflictService.listExternalResolverRuns(arg);
  });

  ipcMain.handle(
    IPC.conflictsCommitExternalResolverRun,
    async (_event, arg: CommitExternalConflictResolverRunArgs): Promise<CommitExternalConflictResolverRunResult> => {
      const ctx = getCtx();
      const committed = await ctx.conflictService.commitExternalResolverRun(arg);
      ctx.jobEngine.runConflictPredictionNow({ laneId: committed.laneId });
      return committed;
    }
  );

  ipcMain.handle(IPC.conflictsPrepareResolverSession, async (_event, arg) => getCtx().conflictService.prepareResolverSession(arg));

  ipcMain.handle(IPC.conflictsAttachResolverSession, async (_event, arg: AttachResolverSessionArgs) =>
    getCtx().conflictService.attachResolverSession(arg)
  );

  ipcMain.handle(IPC.conflictsFinalizeResolverSession, async (_event, arg) => getCtx().conflictService.finalizeResolverSession(arg));

  ipcMain.handle(IPC.conflictsCancelResolverSession, async (_event, arg: CancelResolverSessionArgs) =>
    getCtx().conflictService.cancelResolverSession(arg)
  );

  ipcMain.handle(IPC.conflictsSuggestResolverTarget, async (_event, arg) => getCtx().conflictService.suggestResolverTarget(arg));

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

  ipcMain.handle(IPC.prsCreateFromLane, async (_event, arg: CreatePrFromLaneArgs): Promise<PrSummary> => {
    const ctx = getCtx();
    const result = await ctx.prService.createFromLane(arg);
    ctx.prPollingService.poke();
    return result;
  });

  ipcMain.handle(IPC.prsLinkToLane, async (_event, arg: LinkPrToLaneArgs): Promise<PrSummary> => {
    const ctx = getCtx();
    const result = await ctx.prService.linkToLane(arg);
    ctx.prPollingService.poke();
    return result;
  });

  const ensurePrMutationContext = (): AppContext => {
    const ctx = getCtx();
    if (!ctx.prService || !ctx.prPollingService) {
      throw new Error("PR service is not available for this project window.");
    }
    return ctx;
  };

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

  const ensurePrPolling = () => {
    const ctx = getCtx();
    if (!ctx.prPollingService || !ctx.prService) return null;
    ctx.prPollingService.start();
    return ctx;
  };
  const ensurePrReadContext = (): AppContext => {
    const ctx = ensurePrPolling();
    if (!ctx) throw new Error("PR service is not available for this project window.");
    return ctx;
  };

  ipcMain.handle(IPC.prsGetForLane, async (_event, arg: { laneId: string }): Promise<PrSummary | null> => {
    const ctx = getCtx();
    if (!ctx.prService) return null;
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
    const ctx = getCtx();
    await ctx.prService.updateDescription(arg);
    ctx.prPollingService.poke();
  });

  ipcMain.handle(IPC.prsDelete, async (_event, arg: DeletePrArgs): Promise<DeletePrResult> => {
    const ctx = getCtx();
    const result = await ctx.prService.delete(arg);
    ctx.prPollingService.poke();
    return result;
  });

  ipcMain.handle(IPC.prsDraftDescription, async (_event, arg: DraftPrDescriptionArgs): Promise<{ title: string; body: string }> => {
    const ctx = getCtx();
    return await ctx.prService.draftDescription(arg);
  });

  ipcMain.handle(IPC.prsLand, async (_event, arg: LandPrArgs): Promise<LandResult> => {
    const ctx = getCtx();
    const result = await ctx.prService.land(arg);
    ctx.prPollingService.poke();
    return result;
  });

  ipcMain.handle(IPC.prsLandStack, async (_event, arg: LandStackArgs): Promise<LandResult[]> => {
    const ctx = getCtx();
    const result = await ctx.prService.landStack(arg);
    ctx.prPollingService.poke();
    return result;
  });

  ipcMain.handle(IPC.prsRetargetBase, async (_event, arg: { prId: string; baseBranch: string }): Promise<void> => {
    const ctx = getCtx();
    await ctx.prService.retargetBase(arg.prId, arg.baseBranch);
    ctx.prPollingService.poke();
  });

  ipcMain.handle(IPC.prsOpenInGitHub, async (_event, arg: { prId: string }): Promise<void> => {
    const ctx = getCtx();
    return await ctx.prService.openInGitHub(arg.prId);
  });

  ipcMain.handle(IPC.prsCreateIntegration, async (_event, arg: CreateIntegrationPrArgs): Promise<CreateIntegrationPrResult> => {
    const ctx = getCtx();
    const result = await ctx.prService.createIntegrationPr(arg);
    ctx.prPollingService.poke();
    return result;
  });

  ipcMain.handle(IPC.prsLandStackEnhanced, async (_event, arg: LandStackEnhancedArgs): Promise<LandResult[]> => {
    const ctx = getCtx();
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

  ipcMain.handle(IPC.prsGetGitHubSnapshot, async (_event, arg?: { force?: boolean; includeExternalClosed?: boolean }): Promise<GitHubPrSnapshot> => {
    const ctx = ensurePrReadContext();
    return await ctx.prService.getGithubSnapshot({
      force: arg?.force === true,
      includeExternalClosed: arg?.includeExternalClosed === true,
    });
  });

  ipcMain.handle(IPC.prsCreateQueue, async (_event, arg: CreateQueuePrsArgs): Promise<CreateQueuePrsResult> => {
    const ctx = getCtx();
    const result = await ctx.prService.createQueuePrs(arg);
    ctx.prPollingService.poke();
    return result;
  });

  ipcMain.handle(IPC.prsSimulateIntegration, async (_event, arg: SimulateIntegrationArgs): Promise<IntegrationProposal> => getCtx().prService.simulateIntegration(arg));

  ipcMain.handle(IPC.prsCommitIntegration, async (_event, arg: CommitIntegrationArgs): Promise<CreateIntegrationPrResult> => {
    const ctx = getCtx();
    const result = await ctx.prService.commitIntegration(arg);
    ctx.prPollingService.poke();
    return result;
  });

  ipcMain.handle(IPC.prsListProposals, async (): Promise<IntegrationProposal[]> =>
    await getCtx().prService.listIntegrationProposals(),
  );

  ipcMain.handle(IPC.prsListIntegrationWorkflows, async (_event, arg: ListIntegrationWorkflowsArgs = {}): Promise<IntegrationProposal[]> =>
    await getCtx().prService.listIntegrationWorkflows(arg),
  );

  ipcMain.handle(IPC.prsUpdateProposal, async (_event, arg: UpdateIntegrationProposalArgs): Promise<void> =>
    getCtx().prService.updateIntegrationProposal(arg),
  );

  ipcMain.handle(IPC.prsDeleteProposal, async (_event, arg: DeleteIntegrationProposalArgs): Promise<DeleteIntegrationProposalResult> =>
    await getCtx().prService.deleteIntegrationProposal(arg),
  );

  ipcMain.handle(IPC.prsDismissIntegrationCleanup, async (_event, arg: DismissIntegrationCleanupArgs): Promise<IntegrationProposal> =>
    await getCtx().prService.dismissIntegrationCleanup(arg),
  );

  ipcMain.handle(IPC.prsCleanupIntegrationWorkflow, async (_event, arg: CleanupIntegrationWorkflowArgs): Promise<CleanupIntegrationWorkflowResult> =>
    await getCtx().prService.cleanupIntegrationWorkflow(arg),
  );

  ipcMain.handle(IPC.prsLandQueueNext, async (_event, arg: LandQueueNextArgs): Promise<LandResult> => {
    const ctx = getCtx();
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
    const ctx = getCtx();
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
    getCtx().prService.createIntegrationLaneForProposal(arg));

  ipcMain.handle(IPC.prsStartIntegrationResolution, async (_event, arg: StartIntegrationResolutionArgs): Promise<StartIntegrationResolutionResult> =>
    getCtx().prService.startIntegrationResolution(arg));

  ipcMain.handle(IPC.prsGetIntegrationResolutionState, async (_event, arg: { proposalId: string }): Promise<IntegrationResolutionState | null> =>
    getCtx().prService.getIntegrationResolutionState(arg.proposalId));

  ipcMain.handle(IPC.prsRecheckIntegrationStep, async (_event, arg: RecheckIntegrationStepArgs): Promise<RecheckIntegrationStepResult> =>
    getCtx().prService.recheckIntegrationStep(arg));

  ipcMain.handle(IPC.prsAiResolutionGetSession, async (_event, arg: PrAiResolutionGetSessionArgs): Promise<PrAiResolutionGetSessionResult> => {
    const ctx = getCtx();
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
    const ctx = getCtx();
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
        const detail = getCtx().sessionService.get(runtime.sessionId);
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
    const ctx = getCtx();
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
    const ctx = getCtx();
    await ctx.agentChatService.interrupt({ sessionId });
    await finalizePrAiSession(sessionId, {
      forceStatus: "cancelled",
      message: "AI resolution stopped by user."
    });
  });

  ipcMain.handle(IPC.prsIssueResolutionStart, async (_event, arg: PrIssueResolutionStartArgs): Promise<PrIssueResolutionStartResult> => {
    const ctx = getCtx();
    const result = await launchPrIssueResolutionChat(
      {
        prService: ctx.prService,
        laneService: ctx.laneService,
        agentChatService: ctx.agentChatService,
        sessionService: ctx.sessionService,
        issueInventoryService: ctx.issueInventoryService,
        laneWorktreeLockService: ctx.laneWorktreeLockService,
      },
      arg,
    );
    try {
      const status = ctx.issueInventoryService.getConvergenceStatus(arg.prId);
      ctx.issueInventoryService.saveConvergenceRuntime(arg.prId, {
        currentRound: status.currentRound,
        status: "running",
        pollerStatus: "idle",
        activeSessionId: result.sessionId,
        activeLaneId: result.laneId,
        activeHref: result.href,
        lastStartedAt: nowIso(),
        errorMessage: null,
        pauseReason: null,
      });
    } catch (error) {
      ctx.logger.warn("ipc.prs_issue_resolution_convergence_persist_failed", {
        prId: arg.prId,
        sessionId: result.sessionId,
        laneId: result.laneId,
        href: result.href,
        error: getErrorMessage(error),
      });
    }
    return result;
  });

  ipcMain.handle(IPC.prsIssueResolutionPreviewPrompt, async (
    _event,
    arg: PrIssueResolutionPromptPreviewArgs,
  ): Promise<PrIssueResolutionPromptPreviewResult> => {
    const ctx = getCtx();
    return await previewPrIssueResolutionPrompt(
      {
        prService: ctx.prService,
        laneService: ctx.laneService,
        agentChatService: ctx.agentChatService,
        sessionService: ctx.sessionService,
        issueInventoryService: ctx.issueInventoryService,
        laneWorktreeLockService: ctx.laneWorktreeLockService,
      },
      arg,
    );
  });

  ipcMain.handle(IPC.prsRebaseResolutionStart, async (_event, arg: RebaseResolutionStartArgs): Promise<RebaseResolutionStartResult> => {
    const ctx = getCtx();
    return await launchRebaseResolutionChat(
      {
        laneService: ctx.laneService,
        agentChatService: ctx.agentChatService,
        sessionService: ctx.sessionService,
        conflictService: ctx.conflictService,
      },
      arg,
    );
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
  ipcMain.handle(IPC.prsAddComment, (_e, args) => getCtx().prService.addComment(args));
  ipcMain.handle(IPC.prsReplyToReviewThread, (_e, args: ReplyToPrReviewThreadArgs) => getCtx().prService.replyToReviewThread(args));
  ipcMain.handle(IPC.prsResolveReviewThread, (_e, args: ResolvePrReviewThreadArgs) => getCtx().prService.resolveReviewThread(args));
  ipcMain.handle(IPC.prsUpdateTitle, (_e, args) => getCtx().prService.updateTitle(args));
  ipcMain.handle(IPC.prsUpdateBody, (_e, args) => getCtx().prService.updateBody(args));
  ipcMain.handle(IPC.prsSetLabels, (_e, args) => getCtx().prService.setLabels(args));
  ipcMain.handle(IPC.prsRequestReviewers, (_e, args) => getCtx().prService.requestReviewers(args));
  ipcMain.handle(IPC.prsSubmitReview, (_e, args) => getCtx().prService.submitReview(args));
  ipcMain.handle(IPC.prsClose, (_e, args) => getCtx().prService.closePr(args));
  ipcMain.handle(IPC.prsReopen, (_e, args) => getCtx().prService.reopenPr(args));
  ipcMain.handle(IPC.prsRerunChecks, (_e, args) => getCtx().prService.rerunChecks(args));
  ipcMain.handle(IPC.prsAiReviewSummary, (_e, args) => getCtx().prService.aiReviewSummary(args));

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
  ipcMain.handle(IPC.prsPostReviewComment, (_e, args: PostPrReviewCommentArgs) => getCtx().prService.postReviewComment(args));
  ipcMain.handle(
    IPC.prsSetReviewThreadResolved,
    (_e, args: SetPrReviewThreadResolvedArgs) => getCtx().prService.setReviewThreadResolved(args),
  );
  ipcMain.handle(IPC.prsReactToComment, (_e, args: ReactToPrCommentArgs) => getCtx().prService.reactToComment(args));
  ipcMain.handle(
    IPC.prsLaunchIssueResolutionFromThread,
    async (_e, arg: LaunchPrIssueResolutionFromThreadArgs): Promise<LaunchPrIssueResolutionFromThreadResult> => {
      const ctx = getCtx();
      const additionalInstructions = buildIssueResolutionInstructionsFromThread(arg);
      if (!arg.modelId) {
        throw new Error("modelId is required for prsLaunchIssueResolutionFromThread.");
      }
      return await launchPrIssueResolutionChat(
        {
          prService: ctx.prService,
          laneService: ctx.laneService,
          agentChatService: ctx.agentChatService,
          sessionService: ctx.sessionService,
          issueInventoryService: ctx.issueInventoryService,
          laneWorktreeLockService: ctx.laneWorktreeLockService,
        },
        {
          prId: arg.prId,
          scope: "comments",
          modelId: arg.modelId,
          reasoning: arg.reasoning ?? null,
          permissionMode: arg.permissionMode,
          additionalInstructions,
        },
      );
    },
  );
  ipcMain.handle(IPC.prsCleanupBranch, (_e, args: CleanupPrBranchArgs): Promise<CleanupPrBranchResult> =>
    getCtx().prService.cleanupBranch(args));

  // Issue Inventory (PR convergence loop)
  ipcMain.handle(IPC.prsIssueInventorySync, async (_e, args: { prId: string }): Promise<IssueInventorySnapshot> => {
    const ctx = getCtx();
    const [checks, reviewThreads, comments] = await Promise.all([
      ctx.prService.getChecks(args.prId),
      ctx.prService.getReviewThreads(args.prId),
      ctx.prService.getComments(args.prId).catch(() => []),
    ]);
    return ctx.issueInventoryService.syncFromPrData(args.prId, checks, reviewThreads, comments);
  });
  ipcMain.handle(IPC.prsIssueInventoryGet, (_e, args: { prId: string }): IssueInventorySnapshot =>
    getCtx().issueInventoryService.getInventory(args.prId));
  ipcMain.handle(IPC.prsIssueInventoryGetNew, (_e, args: { prId: string }): IssueInventoryItem[] =>
    getCtx().issueInventoryService.getNewItems(args.prId));
  ipcMain.handle(IPC.prsIssueInventoryMarkFixed, (_e, args: { prId: string; itemIds: string[] }): void =>
    getCtx().issueInventoryService.markFixed(args.prId, args.itemIds));
  ipcMain.handle(IPC.prsIssueInventoryMarkDismissed, (_e, args: { prId: string; itemIds: string[]; reason: string }): void =>
    getCtx().issueInventoryService.markDismissed(args.prId, args.itemIds, args.reason));
  ipcMain.handle(IPC.prsIssueInventoryMarkEscalated, (_e, args: { prId: string; itemIds: string[] }): void =>
    getCtx().issueInventoryService.markEscalated(args.prId, args.itemIds));
  ipcMain.handle(IPC.prsIssueInventoryGetConvergence, (_e, args: { prId: string }): ConvergenceStatus =>
    getCtx().issueInventoryService.getConvergenceStatus(args.prId));
  ipcMain.handle(IPC.prsIssueInventoryReset, (_e, args: { prId: string }): void =>
    getCtx().issueInventoryService.resetInventory(args.prId));

  ipcMain.handle(IPC.prsConvergenceStateGet, (_e, args: { prId: string }): ConvergenceRuntimeState =>
    getCtx().issueInventoryService.getConvergenceRuntime(args.prId));
  ipcMain.handle(IPC.prsConvergenceStateSave, (_e, args: { prId: string; state: PrConvergenceStatePatch }): ConvergenceRuntimeState => {
    // Whitelist: only allow renderer to update operational fields.
    // Identity fields and immutable timestamps are stripped.
    const MUTABLE_FIELDS: ReadonlySet<keyof ConvergenceRuntimeState> = new Set([
      "autoConvergeEnabled",
      "status",
      "pollerStatus",
      "currentRound",
      "activeSessionId",
      "activeLaneId",
      "activeHref",
      "pauseReason",
      "errorMessage",
      "lastStartedAt",
      "lastPolledAt",
      "lastPausedAt",
      "lastStoppedAt",
    ]);
    // Validate that args.state is a plain non-null object before iterating.
    if (args.state == null || typeof args.state !== "object" || Array.isArray(args.state)) {
      return getCtx().issueInventoryService.getConvergenceRuntime(args.prId);
    }

    const VALID_STATUS: ReadonlySet<string> = new Set([
      "idle", "launching", "running", "polling", "paused", "converged", "merged", "failed", "cancelled", "stopped",
    ]);
    const VALID_POLLER_STATUS: ReadonlySet<string> = new Set([
      "idle", "scheduled", "polling", "waiting_for_checks", "waiting_for_comments", "paused", "stopped",
    ]);

    const isStringOrNull = (v: unknown): boolean => v === null || typeof v === "string";

    const sanitized: PrConvergenceStatePatch = {};
    for (const key of Object.keys(args.state) as (keyof ConvergenceRuntimeState)[]) {
      if (!MUTABLE_FIELDS.has(key)) continue;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment
      const val = (args.state as any)[key];
      switch (key) {
        case "autoConvergeEnabled":
          if (typeof val === "boolean") sanitized.autoConvergeEnabled = val;
          break;
        case "status":
          if (typeof val === "string" && VALID_STATUS.has(val)) sanitized.status = val as ConvergenceRuntimeState["status"];
          break;
        case "pollerStatus":
          if (typeof val === "string" && VALID_POLLER_STATUS.has(val)) sanitized.pollerStatus = val as ConvergenceRuntimeState["pollerStatus"];
          break;
        case "currentRound":
          if (typeof val === "number" && Number.isFinite(val) && val >= 0) sanitized.currentRound = val;
          break;
        case "activeSessionId":
        case "activeLaneId":
        case "activeHref":
        case "pauseReason":
        case "errorMessage":
        case "lastStartedAt":
        case "lastPolledAt":
        case "lastPausedAt":
        case "lastStoppedAt":
          if (isStringOrNull(val)) (sanitized as any)[key] = val;
          break;
        default:
          break;
      }
    }
    return getCtx().issueInventoryService.saveConvergenceRuntime(args.prId, sanitized);
  });
  ipcMain.handle(IPC.prsConvergenceStateDelete, (_e, args: { prId: string }): void =>
    getCtx().issueInventoryService.resetConvergenceRuntime(args.prId));

  ipcMain.handle(
    IPC.prsPathToMergeStart,
    async (_e, args: {
      prId: string;
      modelId?: string | null;
      reasoning?: string | null;
      permissionMode?: string | null;
      scope?: "checks" | "comments" | "both";
      additionalInstructions?: string | null;
    }) => {
      const orchestrator = getCtx().pathToMergeOrchestrator;
      if (!orchestrator) {
        throw new Error("Path to Merge orchestrator is not available in this build.");
      }
      const prId = typeof args?.prId === "string" ? args.prId.trim() : "";
      if (!prId) throw new Error("prId is required");
      return await orchestrator.startPathToMerge({
        prId,
        modelId: typeof args?.modelId === "string" ? args.modelId : null,
        reasoning: typeof args?.reasoning === "string" ? args.reasoning : null,
        permissionMode: typeof args?.permissionMode === "string"
          ? args.permissionMode as PrAgentPermissionMode
          : null,
        scope: args?.scope === "checks" || args?.scope === "comments" || args?.scope === "both"
          ? args.scope
          : undefined,
        additionalInstructions: typeof args?.additionalInstructions === "string" ? args.additionalInstructions : null,
      });
    },
  );

  ipcMain.handle(
    IPC.prsPathToMergeStop,
    async (_e, args: { prId: string; reason?: string | null }) => {
      const orchestrator = getCtx().pathToMergeOrchestrator;
      if (!orchestrator) {
        throw new Error("Path to Merge orchestrator is not available in this build.");
      }
      const prId = typeof args?.prId === "string" ? args.prId.trim() : "";
      if (!prId) throw new Error("prId is required");
      return await orchestrator.stopPathToMerge({
        prId,
        reason: typeof args?.reason === "string" ? args.reason : null,
      });
    },
  );

  ipcMain.handle(IPC.prsPipelineSettingsGet, (_e, args: { prId: string }): PipelineSettings =>
    getCtx().issueInventoryService.getPipelineSettings(args.prId));
  ipcMain.handle(IPC.prsPipelineSettingsSave, (_e, args: { prId: string; settings: Partial<PipelineSettings> }): void =>
    getCtx().issueInventoryService.savePipelineSettings(args.prId, args.settings));
  ipcMain.handle(IPC.prsPipelineSettingsDelete, (_e, args: { prId: string }): void =>
    getCtx().issueInventoryService.deletePipelineSettings(args.prId));

  ipcMain.handle(IPC.rebaseScanNeeds, async () => getCtx().conflictService.scanRebaseNeeds());

  ipcMain.handle(IPC.rebaseGetNeed, async (_event, arg) => getCtx().conflictService.getRebaseNeed(arg.laneId));

  ipcMain.handle(IPC.rebaseDismiss, async (_event, arg) => getCtx().conflictService.dismissRebase(arg.laneId));

  ipcMain.handle(IPC.rebaseDefer, async (_event, arg) => getCtx().conflictService.deferRebase(arg.laneId, arg.until));

  ipcMain.handle(IPC.rebaseExecute, async (_event, arg) => getCtx().conflictService.rebaseLane(arg));

  ipcMain.handle(IPC.historyListOperations, async (_event, arg: ListOperationsArgs = {}): Promise<OperationRecord[]> => {
    const ctx = getCtx();
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
    const ctx = getCtx();
    const format: "csv" | "json" = arg?.format === "csv" ? "csv" : "json";
    const laneId = typeof arg?.laneId === "string" && arg.laneId.trim().length > 0 ? arg.laneId.trim() : undefined;
    const kind = typeof arg?.kind === "string" && arg.kind.trim().length > 0 ? arg.kind.trim() : undefined;
    const status = arg?.status;

    const rows = Array.isArray(arg?.rows)
      ? arg.rows
      : ctx.operationService.list({
          laneId,
          kind,
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
    return ctx.processService.listDefinitions();
  });

  ipcMain.handle(IPC.processesListRuntime, async (_event, arg: { laneId: string }): Promise<ProcessRuntime[]> => {
    const ctx = getCtx();
    if (!arg?.laneId) return [];
    return ctx.processService.listRuntime(arg.laneId);
  });

  ipcMain.handle(IPC.processesStart, async (_event, arg: ProcessActionArgs): Promise<ProcessRuntime> => {
    const ctx = getCtx();
    return await ctx.processService.start(arg);
  });

  ipcMain.handle(IPC.processesStop, async (_event, arg: ProcessActionArgs): Promise<ProcessRuntime | null> => {
    const ctx = getCtx();
    return await ctx.processService.stop(arg);
  });

  ipcMain.handle(IPC.processesRestart, async (_event, arg: ProcessActionArgs): Promise<ProcessRuntime> => {
    const ctx = getCtx();
    return await ctx.processService.restart(arg);
  });

  ipcMain.handle(IPC.processesKill, async (_event, arg: ProcessActionArgs): Promise<ProcessRuntime | null> => {
    const ctx = getCtx();
    return await ctx.processService.kill(arg);
  });

  ipcMain.handle(IPC.processesStartStack, async (_event, arg: ProcessStackArgs): Promise<void> => {
    const ctx = getCtx();
    await ctx.processService.startStack(arg);
  });

  ipcMain.handle(IPC.processesStopStack, async (_event, arg: ProcessStackArgs): Promise<void> => {
    const ctx = getCtx();
    await ctx.processService.stopStack(arg);
  });

  ipcMain.handle(IPC.processesRestartStack, async (_event, arg: ProcessStackArgs): Promise<void> => {
    const ctx = getCtx();
    await ctx.processService.restartStack(arg);
  });

  ipcMain.handle(IPC.processesStartGroup, async (_event, arg: ProcessGroupArgs): Promise<void> => {
    const ctx = getCtx();
    await ctx.processService.startGroup(arg);
  });

  ipcMain.handle(IPC.processesStopGroup, async (_event, arg: ProcessGroupArgs): Promise<void> => {
    const ctx = getCtx();
    await ctx.processService.stopGroup(arg);
  });

  ipcMain.handle(IPC.processesRestartGroup, async (_event, arg: ProcessGroupArgs): Promise<void> => {
    const ctx = getCtx();
    await ctx.processService.restartGroup(arg);
  });

  ipcMain.handle(IPC.processesStartAll, async (_event, arg: { laneId: string }): Promise<void> => {
    const ctx = getCtx();
    if (!arg?.laneId) return;
    await ctx.processService.startAll(arg);
  });

  ipcMain.handle(IPC.processesStopAll, async (_event, arg: { laneId: string }): Promise<void> => {
    const ctx = getCtx();
    if (!arg?.laneId) return;
    await ctx.processService.stopAll(arg);
  });

  ipcMain.handle(IPC.processesGetLogTail, async (_event, arg: GetProcessLogTailArgs): Promise<string> => {
    const ctx = getCtx();
    return ctx.processService.getLogTail(arg);
  });

  ipcMain.handle(IPC.testsListSuites, async (): Promise<TestSuiteDefinition[]> => {
    const ctx = getCtx();
    return ctx.testService.listSuites();
  });

  ipcMain.handle(IPC.testsRun, async (_event, arg: RunTestSuiteArgs): Promise<TestRunSummary> => {
    const ctx = getCtx();
    return ctx.testService.run(arg);
  });

  ipcMain.handle(IPC.testsStop, async (_event, arg: StopTestRunArgs): Promise<void> => {
    const ctx = getCtx();
    ctx.testService.stop(arg);
  });

  ipcMain.handle(IPC.testsListRuns, async (_event, arg: ListTestRunsArgs = {}): Promise<TestRunSummary[]> => {
    const ctx = getCtx();
    return ctx.testService.listRuns(arg);
  });

  ipcMain.handle(IPC.testsGetLogTail, async (_event, arg: GetTestLogTailArgs): Promise<string> => {
    const ctx = getCtx();
    return ctx.testService.getLogTail(arg);
  });

  ipcMain.handle(IPC.projectConfigGet, async (): Promise<ProjectConfigSnapshot> => {
    const ctx = getCtx();
    return ctx.projectConfigService.get();
  });

  ipcMain.handle(IPC.projectConfigValidate, async (_event, arg: { candidate: ProjectConfigCandidate }): Promise<ProjectConfigValidationResult> => {
    const ctx = getCtx();
    return ctx.projectConfigService.validate(arg.candidate);
  });

  ipcMain.handle(IPC.projectConfigSave, async (_event, arg: { candidate: ProjectConfigCandidate }): Promise<ProjectConfigSnapshot> => {
    const ctx = getCtx();
    const next = ctx.projectConfigService.save(arg.candidate);
    try {
      ctx.automationService.syncFromConfig();
    } catch {
      // ignore schedule refresh failures
    }
    return next;
  });

  ipcMain.handle(IPC.projectConfigDiffAgainstDisk, async (): Promise<ProjectConfigDiff> => {
    const ctx = getCtx();
    return ctx.projectConfigService.diffAgainstDisk();
  });

  ipcMain.handle(IPC.projectConfigConfirmTrust, async (_event, arg: { sharedHash?: string } = {}): Promise<ProjectConfigTrust> => {
    const ctx = getCtx();
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

  // -- W2: Worker Agents & Org Chart --

  ipcMain.handle(IPC.ctoListAgents, async (_event, arg: CtoListAgentsArgs = {}): Promise<AgentIdentity[]> => {
    const ctx = getCtx();
    if (!ctx.workerAgentService) throw new Error("Worker agent service is not available.");
    return ctx.workerAgentService.listAgents(arg);
  });

  ipcMain.handle(IPC.ctoSaveAgent, async (_event, arg: CtoSaveAgentArgs): Promise<AgentIdentity> => {
    const ctx = getCtx();
    if (!ctx.workerRevisionService) throw new Error("Worker revision service is not available.");
    return ctx.workerRevisionService.saveAgent(arg.agent, arg.actor ?? "user");
  });

  ipcMain.handle(IPC.ctoRemoveAgent, async (_event, arg: CtoRemoveAgentArgs): Promise<void> => {
    const ctx = getCtx();
    if (!ctx.workerAgentService) throw new Error("Worker agent service is not available.");
    ctx.workerAgentService.removeAgent(arg.agentId);
    ctx.workerHeartbeatService?.syncFromConfig();
  });

  ipcMain.handle(IPC.ctoSetAgentStatus, async (_event, arg: CtoSetAgentStatusArgs): Promise<void> => {
    const ctx = getCtx();
    if (!ctx.workerAgentService) throw new Error("Worker agent service is not available.");
    ctx.workerAgentService.setAgentStatus(arg.agentId, arg.status);
    ctx.workerHeartbeatService?.syncFromConfig();
  });

  ipcMain.handle(IPC.ctoListAgentRevisions, async (_event, arg: CtoListAgentRevisionsArgs): Promise<AgentConfigRevision[]> => {
    const ctx = getCtx();
    if (!ctx.workerRevisionService) throw new Error("Worker revision service is not available.");
    return ctx.workerRevisionService.listAgentRevisions(arg.agentId, arg.limit ?? 20);
  });

  ipcMain.handle(IPC.ctoRollbackAgentRevision, async (_event, arg: CtoRollbackAgentRevisionArgs): Promise<AgentIdentity> => {
    const ctx = getCtx();
    if (!ctx.workerRevisionService) throw new Error("Worker revision service is not available.");
    return ctx.workerRevisionService.rollbackAgentRevision(arg.agentId, arg.revisionId, arg.actor ?? "user");
  });

  ipcMain.handle(IPC.ctoEnsureAgentSession, async (_event, arg: CtoEnsureAgentSessionArgs): Promise<AgentChatSession> => {
    const ctx = getCtx();
    if (!ctx.agentChatService) throw new Error("Agent chat service is not available.");
    const laneId = await resolvePrimaryLaneIdOnly(ctx);
    if (!laneId) throw new Error("No primary lane is available to host the agent chat session.");
    return ctx.agentChatService.ensureIdentitySession({
      identityKey: `agent:${arg.agentId}`,
      laneId,
      modelId: arg.modelId ?? null,
      reasoningEffort: arg.reasoningEffort ?? null,
      permissionMode: "full-auto",
    });
  });

  ipcMain.handle(IPC.ctoGetBudgetSnapshot, async (_event, arg: CtoGetBudgetSnapshotArgs = {}): Promise<AgentBudgetSnapshot> => {
    const ctx = getCtx();
    if (!ctx.workerBudgetService) throw new Error("Worker budget service is not available.");
    return ctx.workerBudgetService.getBudgetSnapshot({ monthKey: arg.monthKey });
  });

  ipcMain.handle(IPC.ctoUpdateIdentity, async (_event, arg: CtoUpdateIdentityArgs): Promise<CtoSnapshot> => {
    const ctx = getCtx();
    if (!ctx.ctoStateService) throw new Error("CTO state service is not available.");
    return ctx.ctoStateService.updateIdentity(arg.patch ?? {});
  });

  // -- W3: Heartbeat & Activation --

  ipcMain.handle(IPC.ctoTriggerAgentWakeup, async (_event, arg: CtoTriggerAgentWakeupArgs): Promise<CtoTriggerAgentWakeupResult> => {
    const ctx = getCtx();
    if (!ctx.workerHeartbeatService) throw new Error("Worker heartbeat service is not available.");
    return ctx.workerHeartbeatService.triggerWakeup(arg);
  });

  ipcMain.handle(IPC.ctoListAgentRuns, async (_event, arg: CtoListAgentRunsArgs = {}): Promise<WorkerAgentRun[]> => {
    const ctx = getCtx();
    if (!ctx.workerHeartbeatService) throw new Error("Worker heartbeat service is not available.");
    return ctx.workerHeartbeatService.listRuns(arg);
  });

  ipcMain.handle(IPC.ctoListAgentSessionLogs, async (_event, arg: CtoListAgentSessionLogsArgs): Promise<AgentSessionLogEntry[]> => {
    const ctx = getCtx();
    if (!ctx.workerHeartbeatService) throw new Error("Worker heartbeat service is not available.");
    return ctx.workerHeartbeatService.listAgentSessionLogs(arg.agentId, arg.limit ?? 40);
  });

  ipcMain.handle(IPC.ctoListAgentTaskSessions, async (_event, arg: CtoListAgentTaskSessionsArgs): Promise<AgentTaskSession[]> => {
    const ctx = getCtx();
    if (!ctx.workerTaskSessionService) throw new Error("Worker task session service is not available.");
    return ctx.workerTaskSessionService.listAgentTaskSessions(arg.agentId, arg.limit ?? 40);
  });

  ipcMain.handle(IPC.ctoClearAgentTaskSession, async (_event, arg: CtoClearAgentTaskSessionArgs): Promise<void> => {
    const ctx = getCtx();
    if (!ctx.workerTaskSessionService) throw new Error("Worker task session service is not available.");
    ctx.workerTaskSessionService.clearAgentTaskSession(arg);
  });

  // -- W4: Bidirectional Linear Sync --

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

  ipcMain.handle(IPC.ctoGetFlowPolicy, async (): Promise<LinearWorkflowConfig> => {
    const ctx = getCtx();
    if (!ctx.flowPolicyService) throw new Error("Flow policy service is not available.");
    return ctx.flowPolicyService.getPolicy();
  });

  ipcMain.handle(IPC.ctoSaveFlowPolicy, async (_event, arg: CtoSaveFlowPolicyArgs): Promise<LinearWorkflowConfig> => {
    const ctx = getCtx();
    if (!ctx.flowPolicyService) throw new Error("Flow policy service is not available.");
    const saved = ctx.flowPolicyService.savePolicy(arg.policy, arg.actor ?? "user");
    return saved;
  });

  ipcMain.handle(IPC.ctoListFlowPolicyRevisions, async (): Promise<CtoFlowPolicyRevision[]> => {
    const ctx = getCtx();
    if (!ctx.flowPolicyService) throw new Error("Flow policy service is not available.");
    return ctx.flowPolicyService.listRevisions(50);
  });

  ipcMain.handle(IPC.ctoRollbackFlowPolicyRevision, async (_event, arg: CtoRollbackFlowPolicyRevisionArgs): Promise<LinearWorkflowConfig> => {
    const ctx = getCtx();
    if (!ctx.flowPolicyService) throw new Error("Flow policy service is not available.");
    return ctx.flowPolicyService.rollbackRevision(arg.revisionId, arg.actor ?? "user");
  });

  ipcMain.handle(IPC.ctoSimulateFlowRoute, async (_event, arg: CtoSimulateFlowRouteArgs): Promise<LinearRouteDecision> => {
    const ctx = getCtx();
    if (!ctx.linearRoutingService) throw new Error("Linear routing service is not available.");

    const now = nowIso();
    const policy = ctx.flowPolicyService?.getPolicy();
    const defaultProjectSlug =
      policy?.workflows.flatMap((workflow) => workflow.triggers.projectSlugs ?? []).find(Boolean)
      ?? policy?.legacyConfig?.projects?.[0]?.slug
      ?? "sim-project";
    const issue: NormalizedLinearIssue = {
      id: arg.issue.id ?? `sim-${randomUUID()}`,
      identifier: arg.issue.identifier ?? "SIM-1",
      title: arg.issue.title,
      description: arg.issue.description ?? "",
      url: arg.issue.url ?? null,
      projectId: arg.issue.projectId ?? "sim-project",
      projectSlug: arg.issue.projectSlug ?? defaultProjectSlug,
      teamId: arg.issue.teamId ?? "sim-team",
      teamKey: arg.issue.teamKey ?? "SIM",
      stateId: arg.issue.stateId ?? "sim-state",
      stateName: arg.issue.stateName ?? "Todo",
      stateType: arg.issue.stateType ?? "unstarted",
      priority: Number.isFinite(Number(arg.issue.priority)) ? Number(arg.issue.priority) : 3,
      priorityLabel: arg.issue.priorityLabel ?? "normal",
      labels: Array.isArray(arg.issue.labels) ? arg.issue.labels : [],
      metadataTags: Array.isArray(arg.issue.metadataTags) ? arg.issue.metadataTags : [],
      assigneeId: arg.issue.assigneeId ?? null,
      assigneeName: arg.issue.assigneeName ?? null,
      ownerId: arg.issue.ownerId ?? null,
      creatorId: arg.issue.creatorId ?? null,
      creatorName: arg.issue.creatorName ?? null,
      blockerIssueIds: Array.isArray(arg.issue.blockerIssueIds) ? arg.issue.blockerIssueIds : [],
      hasOpenBlockers: Boolean(arg.issue.hasOpenBlockers),
      createdAt: arg.issue.createdAt ?? now,
      updatedAt: arg.issue.updatedAt ?? now,
      raw: isRecord(arg.issue.raw) ? arg.issue.raw : {},
    };
    return ctx.linearRoutingService.simulateRoute({ issue });
  });

  ipcMain.handle(IPC.ctoGetLinearWorkflowCatalog, async (): Promise<LinearWorkflowCatalog> => {
    const ctx = getCtx();
    if (!ctx.linearIssueTracker) throw new Error("Linear issue tracker is not available.");
    const [users, labels, states] = await Promise.all([
      ctx.linearIssueTracker.listUsers(),
      ctx.linearIssueTracker.listLabels(),
      ctx.linearIssueTracker.listWorkflowStates(),
    ]);
    return { users, labels, states };
  });

  ipcMain.handle(IPC.ctoGetLinearSyncDashboard, async (): Promise<LinearSyncDashboard> => {
    const ctx = getCtx();
    if (!ctx.linearSyncService) throw new Error("Linear sync service is not available.");
    return ctx.linearSyncService.getDashboard();
  });

  ipcMain.handle(IPC.ctoRunLinearSyncNow, async (): Promise<LinearSyncDashboard> => {
    const ctx = getCtx();
    if (!ctx.linearSyncService) throw new Error("Linear sync service is not available.");
    return ctx.linearSyncService.runSyncNow();
  });

  ipcMain.handle(IPC.ctoListLinearSyncQueue, async (): Promise<LinearSyncQueueItem[]> => {
    const ctx = getCtx();
    if (!ctx.linearSyncService) throw new Error("Linear sync service is not available.");
    return ctx.linearSyncService.listQueue({ limit: 300 });
  });

  ipcMain.handle(
    IPC.ctoResolveLinearSyncQueueItem,
    async (_event, arg: CtoResolveLinearSyncQueueItemArgs): Promise<LinearSyncQueueItem | null> => {
      const ctx = getCtx();
      if (!ctx.linearSyncService) throw new Error("Linear sync service is not available.");
      return ctx.linearSyncService.resolveQueueItem(arg);
    }
  );

  ipcMain.handle(
    IPC.ctoGetLinearWorkflowRunDetail,
    async (_event, arg: CtoGetLinearWorkflowRunDetailArgs): Promise<LinearWorkflowRunDetail | null> => {
      const ctx = getCtx();
      if (!ctx.linearSyncService) throw new Error("Linear sync service is not available.");
      return ctx.linearSyncService.getRunDetail(arg);
    }
  );

  ipcMain.handle(IPC.ctoGetLinearIngressStatus, async (): Promise<LinearIngressStatus> => {
    const ctx = getCtx();
    if (!ctx.linearIngressService) throw new Error("Linear ingress service is not available.");
    return ctx.linearIngressService.getStatus();
  });

  ipcMain.handle(
    IPC.ctoListLinearIngressEvents,
    async (_event, arg: CtoListLinearIngressEventsArgs | undefined): Promise<LinearIngressEventRecord[]> => {
      const ctx = getCtx();
      if (!ctx.linearIngressService) throw new Error("Linear ingress service is not available.");
      return ctx.linearIngressService.listRecentEvents(arg?.limit ?? 20);
    }
  );

  ipcMain.handle(IPC.ctoEnsureLinearWebhook, async (_event, arg: CtoEnsureLinearWebhookArgs | undefined): Promise<LinearIngressStatus> => {
    const ctx = getCtx();
    if (!ctx.linearIngressService) throw new Error("Linear ingress service is not available.");
    await ctx.linearIngressService.ensureRelayWebhook(arg?.force === true);
    return ctx.linearIngressService.getStatus();
  });

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

  ipcMain.handle(IPC.ctoRunProjectScan, async (): Promise<CtoRunProjectScanResult> => {
    const ctx = getCtx();
    const detection = await ctx.onboardingService.detectDefaults().catch(() => null);
    return { detection };
  });

  ipcMain.handle(IPC.updateCheckForUpdates, () => {
    getCtx().autoUpdateService?.checkForUpdates();
  });

  ipcMain.handle(IPC.updateGetState, () => {
    return getCtx().autoUpdateService?.getSnapshot() ?? createEmptyAutoUpdateSnapshot();
  });

  ipcMain.handle(IPC.updateQuitAndInstall, () => {
    return getCtx().autoUpdateService?.quitAndInstall() ?? false;
  });

  ipcMain.handle(IPC.updateDismissInstalledNotice, () => {
    getCtx().autoUpdateService?.dismissInstalledNotice();
  });

  // --------------------------------------------------------------------
  // Mobile Push (APNs) — bridge for the MobilePushPanel settings UI
  // --------------------------------------------------------------------
  const readApnsStatus = (): ApnsBridgeStatus => {
    const ctx = getCtx();
    const effective = ctx.projectConfigService?.get?.()?.effective;
    const apnsConfig = effective?.notifications?.apns ?? null;
    return {
      enabled: apnsConfig?.enabled === true,
      configured: ctx.apnsService?.isConfigured?.() === true,
      keyStored: ctx.apnsKeyStore?.has?.() === true,
      keyId: apnsConfig?.keyId ?? null,
      teamId: apnsConfig?.teamId ?? null,
      bundleId: apnsConfig?.bundleId ?? null,
      env: apnsConfig?.env === "production" ? "production" : "sandbox",
    };
  };

  const saveApnsConfigToProject = (next: ApnsBridgeSaveConfigArgs): void => {
    const ctx = getCtx();
    if (!ctx.projectConfigService) return;
    const snapshot = ctx.projectConfigService.get();
    const shared = snapshot.shared ?? {};
    const sharedNotifications =
      (shared as Record<string, unknown>).notifications &&
      typeof (shared as Record<string, unknown>).notifications === "object"
        ? ((shared as Record<string, unknown>).notifications as Record<string, unknown>)
        : {};
    ctx.projectConfigService.save({
      shared: {
        ...shared,
        notifications: {
          ...sharedNotifications,
          apns: {
            enabled: next.enabled,
            keyId: next.keyId,
            teamId: next.teamId,
            bundleId: next.bundleId,
            env: next.env,
          },
        },
      },
      local: snapshot.local ?? {},
    });
  };

  // Re-run ApnsService.configure when we have both a stored key and valid config.
  const reconfigureApnsIfReady = (): void => {
    const ctx = getCtx();
    const effective = ctx.projectConfigService?.get?.()?.effective;
    const apnsConfig = effective?.notifications?.apns ?? null;
    if (!ctx.apnsService || !ctx.apnsKeyStore) return;
    if (!apnsConfig?.enabled) return;
    if (!apnsConfig.keyId || !apnsConfig.teamId || !apnsConfig.bundleId) return;
    if (!ctx.apnsKeyStore.has()) return;
    try {
      const pem = ctx.apnsKeyStore.load();
      if (!pem) return;
      ctx.apnsService.configure({
        keyP8Pem: pem,
        keyId: apnsConfig.keyId,
        teamId: apnsConfig.teamId,
        bundleId: apnsConfig.bundleId,
        env: apnsConfig.env === "production" ? "production" : "sandbox",
      });
    } catch (error) {
      // Surface to the caller via status; don't crash the handler.
      console.warn("apns.reconfigure_failed", error);
    }
  };

  ipcMain.handle(IPC.notificationsApnsGetStatus, async (): Promise<ApnsBridgeStatus> => {
    return readApnsStatus();
  });

  ipcMain.handle(
    IPC.notificationsApnsSaveConfig,
    async (_event, args: ApnsBridgeSaveConfigArgs): Promise<ApnsBridgeStatus> => {
      const ctx = getCtx();
      if (!args.enabled) {
        saveApnsConfigToProject(args);
        await ctx.apnsService?.reset?.();
        return readApnsStatus();
      }
      // Validate against any stored key before committing the new metadata so
      // a failed save cannot replace a previously working APNs configuration.
      if (args.enabled && ctx.apnsService && ctx.apnsKeyStore?.has()) {
        const pem = ctx.apnsKeyStore.load();
        if (pem) {
          try {
            ctx.apnsService.configure({
              keyP8Pem: pem,
              keyId: args.keyId,
              teamId: args.teamId,
              bundleId: args.bundleId,
              env: args.env,
            });
          } catch (error) {
            throw new Error(
              `APNs configure failed: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }
      } else {
        await ctx.apnsService?.reset?.();
      }
      saveApnsConfigToProject(args);
      return readApnsStatus();
    },
  );

  ipcMain.handle(
    IPC.notificationsApnsUploadKey,
    async (_event, args: ApnsBridgeUploadKeyArgs): Promise<ApnsBridgeStatus> => {
      const ctx = getCtx();
      if (!ctx.apnsKeyStore) throw new Error("ApnsKeyStore unavailable.");
      const trimmed = (args.p8Pem ?? "").trim();
      if (!trimmed) throw new Error("Empty .p8 payload.");
      // If complete config is already persisted (second upload / rotation),
      // configure first so an invalid key never replaces a working one on disk.
      const effective = ctx.projectConfigService?.get?.()?.effective;
      const apnsConfig = effective?.notifications?.apns ?? null;
      if (
        apnsConfig?.enabled &&
        apnsConfig.keyId &&
        apnsConfig.teamId &&
        apnsConfig.bundleId &&
        ctx.apnsService
      ) {
        try {
          ctx.apnsService.configure({
            keyP8Pem: trimmed,
            keyId: apnsConfig.keyId,
            teamId: apnsConfig.teamId,
            bundleId: apnsConfig.bundleId,
            env: apnsConfig.env === "production" ? "production" : "sandbox",
          });
        } catch (error) {
          throw new Error(
            `APNs configure failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      ctx.apnsKeyStore.save(trimmed);
      return readApnsStatus();
    },
  );

  ipcMain.handle(IPC.notificationsApnsClearKey, async (): Promise<ApnsBridgeStatus> => {
    const ctx = getCtx();
    ctx.apnsKeyStore?.clear?.();
    await ctx.apnsService?.reset?.();
    return readApnsStatus();
  });

  ipcMain.handle(
    IPC.notificationsApnsSendTestPush,
    async (_event, args: ApnsBridgeSendTestPushArgs): Promise<ApnsBridgeSendTestPushResult> => {
      const ctx = getCtx();
      if (!ctx.apnsService || !ctx.apnsService.isConfigured?.()) {
        return { ok: false, reason: "APNs not configured. Upload a .p8 and save the config." };
      }
      const registry = getOptionalSyncService()?.getDeviceRegistryService?.() ?? null;
      if (!registry) return { ok: false, reason: "Device registry unavailable." };
      const effective = ctx.projectConfigService?.get?.()?.effective;
      const apnsConfig = effective?.notifications?.apns ?? null;
      const configuredBundleId = apnsConfig?.bundleId?.trim() ?? "";
      const devices = registry
        .listDevices()
        .filter((d) => d.platform === "iOS" && d.deviceType === "phone");
      const kind = args.kind ?? "generic";

      const target = args.deviceId
        ? devices.find((d) => d.deviceId === args.deviceId) ?? null
        : devices[0] ?? null;
      if (!target) return { ok: false, reason: "No paired iOS device in the registry." };
      const meta = target.metadata ?? {};
      const deviceBundleId =
        typeof meta.apnsBundleId === "string" && meta.apnsBundleId.trim().length > 0
          ? meta.apnsBundleId.trim()
          : configuredBundleId;
      if (!deviceBundleId) return { ok: false, reason: "No APNs bundle id found for this device or project." };
      const deviceEnv =
        meta.apnsEnv === "production"
          ? "production"
          : meta.apnsEnv === "sandbox"
            ? "sandbox"
            : apnsConfig?.env === "production"
              ? "production"
              : "sandbox";

      // Pick the right (token, topic, pushType, payload) quadruple based on kind.
      let deviceToken: string | null;
      let topic: string;
      let pushType: "alert" | "liveactivity";
      let payload: Record<string, unknown>;

      if (kind === "la_start") {
        deviceToken = typeof meta.apnsActivityStartToken === "string" ? meta.apnsActivityStartToken : null;
        if (!deviceToken) {
          return {
            ok: false,
            reason: "Device has no Live Activity push-to-start token yet (iOS 17.2+ registers this shortly after launch).",
          };
        }
        topic = `${deviceBundleId}.push-type.liveactivity`;
        pushType = "liveactivity";
        payload = buildLiveActivityStartPayload();
      } else if (kind === "la_update_running" || kind === "la_update_attention" || kind === "la_update_multi") {
        const tokenMap = (meta.apnsActivityUpdateTokens ?? null) as Record<string, string> | null;
        const tokens = tokenMap ? Object.values(tokenMap).filter((t): t is string => typeof t === "string" && t.length > 0) : [];
        deviceToken = tokens[0] ?? null;
        if (!deviceToken) {
          return {
            ok: false,
            reason: "No active Live Activity on device to update. Start one first (or fire 'Live Activity · start').",
          };
        }
        topic = `${deviceBundleId}.push-type.liveactivity`;
        pushType = "liveactivity";
        payload = buildLiveActivityUpdatePayload(kind);
      } else if (kind === "la_end") {
        const tokenMap = (meta.apnsActivityUpdateTokens ?? null) as Record<string, string> | null;
        const tokens = tokenMap ? Object.values(tokenMap).filter((t): t is string => typeof t === "string" && t.length > 0) : [];
        deviceToken = tokens[0] ?? null;
        if (!deviceToken) {
          return { ok: false, reason: "No active Live Activity on device to end." };
        }
        topic = `${deviceBundleId}.push-type.liveactivity`;
        pushType = "liveactivity";
        payload = buildLiveActivityEndPayload();
      } else {
        deviceToken = typeof meta.apnsAlertToken === "string" ? meta.apnsAlertToken : null;
        if (!deviceToken) {
          return {
            ok: false,
            reason:
              "Device has no APNs alert token yet. Make sure you accepted the notification permission prompt on the iOS app (Settings → Notifications → ADE → Allow).",
          };
        }
        topic = deviceBundleId;
        pushType = "alert";
        payload = buildTestPushPayload(kind);
      }

      try {
        const result = await ctx.apnsService.send({
          deviceToken,
          env: deviceEnv,
          pushType,
          topic,
          priority: 10,
          payload,
        });
        if (result.ok) return { ok: true };
        return { ok: false, reason: result.reason ?? "APNs rejected the push." };
      } catch (error) {
        return {
          ok: false,
          reason: error instanceof Error ? error.message : "Unknown send error.",
        };
      }
    },
  );
}

// ════════════════════════════════════════════════════════════════════════════
// Live Activity payload helpers
// ════════════════════════════════════════════════════════════════════════════

/**
 * Swift Codable default for `Date` is seconds since 2001-01-01 00:00:00 UTC
 * (NSDate reference date). Convert Unix seconds so the ContentState
 * decoder on-device parses our dates correctly.
 */
const NSDATE_REFERENCE_OFFSET_SECONDS = 978_307_200;
function toNSDateSeconds(unixSeconds: number): number {
  return unixSeconds - NSDATE_REFERENCE_OFFSET_SECONDS;
}

/**
 * Build a minimal valid `ContentState` matching `ADESessionAttributes.ContentState`
 * on-device. `variant` selects which UI state to drive the island into.
 */
function buildContentState(
  variant: "running" | "attention" | "multi",
): Record<string, unknown> {
  const nowUnix = Math.floor(Date.now() / 1000);
  const nowRef = toNSDateSeconds(nowUnix);

  const sessionRunning = {
    id: "test-la-claude",
    providerSlug: "claude",
    title: "Push test · Claude",
    isAwaitingInput: false,
    isFailed: false,
    startedAt: nowRef - 60,
    toolCalls: 4,
    preview: "Reading src/auth/oauth.ts",
    progress: 0.32,
  };
  const sessionAwaiting = {
    id: "test-la-claude",
    providerSlug: "claude",
    title: "Push test · Claude",
    isAwaitingInput: true,
    isFailed: false,
    startedAt: nowRef - 120,
    toolCalls: 7,
    preview: "Approve 3 file writes to continue",
  };
  const sessionCodex = {
    id: "test-la-codex",
    providerSlug: "codex",
    title: "tests-fix",
    isAwaitingInput: false,
    isFailed: false,
    startedAt: nowRef - 30,
    toolCalls: 2,
  };
  const sessionCto = {
    id: "test-la-cto",
    providerSlug: "cto",
    title: "daily-review",
    isAwaitingInput: false,
    isFailed: false,
    startedAt: nowRef - 240,
    toolCalls: 11,
  };

  if (variant === "attention") {
    return {
      sessions: [sessionAwaiting],
      attention: {
        kind: "awaitingInput",
        title: "Claude · Push test",
        subtitle: "3 file writes need approval",
        providerSlug: "claude",
        sessionId: sessionAwaiting.id,
        itemId: "test-item-1",
      },
      failingCheckCount: 0,
      awaitingReviewCount: 0,
      mergeReadyCount: 0,
      generatedAt: nowRef,
    };
  }
  if (variant === "multi") {
    return {
      sessions: [sessionRunning, sessionCodex, sessionCto],
      attention: null,
      failingCheckCount: 1,
      awaitingReviewCount: 2,
      mergeReadyCount: 0,
      generatedAt: nowRef,
    };
  }
  // variant === "running"
  return {
    sessions: [sessionRunning],
    attention: null,
    failingCheckCount: 0,
    awaitingReviewCount: 0,
    mergeReadyCount: 0,
    generatedAt: nowRef,
  };
}

function buildLiveActivityStartPayload(): Record<string, unknown> {
  const nowUnix = Math.floor(Date.now() / 1000);
  return {
    aps: {
      timestamp: nowUnix,
      event: "start",
      "attributes-type": "ADESessionAttributes",
      attributes: { workspaceId: "default", workspaceName: "Test Workspace" },
      "content-state": buildContentState("running"),
      "stale-date": nowUnix + 300,
      "relevance-score": 100,
      alert: {
        title: "ADE · Live Activity started",
        body: "Tap to open.",
      },
    },
  };
}

function buildLiveActivityUpdatePayload(
  kind: "la_update_running" | "la_update_attention" | "la_update_multi",
): Record<string, unknown> {
  const nowUnix = Math.floor(Date.now() / 1000);
  const variant =
    kind === "la_update_attention" ? "attention" : kind === "la_update_multi" ? "multi" : "running";
  return {
    aps: {
      timestamp: nowUnix,
      event: "update",
      "content-state": buildContentState(variant),
      "stale-date": nowUnix + 300,
      "relevance-score": variant === "attention" ? 100 : variant === "multi" ? 60 : 40,
      alert:
        variant === "attention"
          ? {
              title: "Claude · Push test",
              body: "Approval needed — tap Approve/Deny in the island.",
            }
          : variant === "multi"
            ? { title: "ADE", body: "3 chats running · 1 CI failing · 2 reviews pending" }
            : { title: "Claude · Push test", body: "Reading src/auth/oauth.ts" },
    },
  };
}

function buildLiveActivityEndPayload(): Record<string, unknown> {
  const nowUnix = Math.floor(Date.now() / 1000);
  return {
    aps: {
      timestamp: nowUnix,
      event: "end",
      "content-state": buildContentState("running"),
      "dismissal-date": nowUnix + 30,
      alert: { title: "ADE", body: "Live Activity ended." },
    },
  };
}

/**
 * Build a self-contained APNs payload for each test-push category. Each
 * payload is shaped to exercise the exact code path a real notification
 * of that kind would go through on iOS: category identifier, mutable-content
 * for the NotificationServiceExtension, thread-id for grouping,
 * interruption-level, and any custom metadata the action handlers need
 * (sessionId, itemId, prId, prNumber).
 */
function buildTestPushPayload(kind: ApnsTestPushKind): Record<string, unknown> {
  switch (kind) {
    case "awaiting_input":
      return {
        aps: {
          alert: {
            title: "Claude · ADE mobile",
            body: "3 file writes need approval before I continue.",
          },
          sound: "default",
          "mutable-content": 1,
          "interruption-level": "time-sensitive",
          "relevance-score": 1.0,
          "thread-id": "chat:test-approval-session:approval",
          category: "CHAT_AWAITING_INPUT",
        },
        providerSlug: "claude",
        sessionId: "test-approval-session",
        itemId: "test-item-001",
        kind: "approval",
      };
    case "chat_failed":
      return {
        aps: {
          alert: {
            title: "Codex · tests-fix",
            body: "Session failed: rate limit exceeded after 24 tool calls.",
          },
          sound: "default",
          "mutable-content": 1,
          "interruption-level": "active",
          "relevance-score": 0.7,
          "thread-id": "chat:test-failed-session",
          category: "CHAT_FAILED",
        },
        providerSlug: "codex",
        sessionId: "test-failed-session",
      };
    case "chat_turn_completed":
      return {
        aps: {
          alert: {
            title: "Claude · auth-refactor",
            body: "Finished replying. 14 file edits, 3 new tests added.",
          },
          sound: "default",
          "mutable-content": 1,
          "interruption-level": "active",
          "relevance-score": 0.4,
          "thread-id": "chat:test-completed-session",
          category: "CHAT_TURN_COMPLETED",
        },
        providerSlug: "claude",
        sessionId: "test-completed-session",
      };
    case "ci_failing":
      return {
        aps: {
          alert: {
            title: "PR #412 · auth-refactor",
            body: "3 checks failing: lint, tsc, integration-tests.",
          },
          sound: "default",
          "mutable-content": 1,
          "interruption-level": "active",
          "relevance-score": 0.8,
          "thread-id": "pr:412",
          category: "PR_CI_FAILING",
        },
        prId: "test-pr-412",
        prNumber: 412,
      };
    case "review_requested":
      return {
        aps: {
          alert: {
            title: "PR #408 · new-widget",
            body: "alice requested your review.",
          },
          sound: "default",
          "mutable-content": 1,
          "interruption-level": "active",
          "relevance-score": 0.7,
          "thread-id": "pr:408",
          category: "PR_REVIEW_REQUESTED",
        },
        prId: "test-pr-408",
        prNumber: 408,
      };
    case "merge_ready":
      return {
        aps: {
          alert: {
            title: "PR #401 · refactor-auth",
            body: "All checks passed and approved. Ready to merge.",
          },
          sound: "default",
          "mutable-content": 1,
          "interruption-level": "active",
          "relevance-score": 0.6,
          "thread-id": "pr:401",
          category: "PR_MERGE_READY",
        },
        prId: "test-pr-401",
        prNumber: 401,
      };
    case "cto_subagent_finished":
      return {
        aps: {
          alert: {
            title: "CTO · daily-review",
            body: "Sub-agent 'Lint cleanup' finished (3 PRs opened).",
          },
          sound: "default",
          "mutable-content": 1,
          "interruption-level": "active",
          "relevance-score": 0.5,
          "thread-id": "cto:test-subagent",
          category: "CTO_SUBAGENT_FINISHED",
        },
        providerSlug: "cto",
      };
    case "generic":
    default:
      return {
        aps: {
          alert: {
            title: "ADE",
            body: "Mobile push is working. Tap to open ADE.",
          },
          sound: "default",
          "mutable-content": 1,
          "interruption-level": "active",
          "relevance-score": 0.5,
          category: "SYSTEM_ALERT",
        },
        providerSlug: "ade",
        testPush: true,
      };
  }
}
