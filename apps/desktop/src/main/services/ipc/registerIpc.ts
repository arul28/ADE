import { app, BrowserWindow, clipboard, dialog, ipcMain, shell } from "electron";
import { createEmptyAutoUpdateSnapshot, type createAutoUpdateService } from "../updates/autoUpdateService";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import type { Server as NetServer } from "node:net";
import path from "node:path";
import { IPC } from "../../../shared/ipc";
import { getModelById } from "../../../shared/modelRegistry";
import { buildPrAiResolutionContextKey } from "../../../shared/types";
import { launchPrIssueResolutionChat, previewPrIssueResolutionPrompt } from "../prs/prIssueResolver";
import { launchRebaseResolutionChat } from "../prs/prRebaseResolver";
import { browseProjectDirectories } from "../projects/projectBrowserService";
import { getProjectDetail } from "../projects/projectDetailService";
import { runGit } from "../git/git";
import type { AdeCleanupResult, AdeProjectSnapshot } from "../../../shared/types";
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
  GitBranchSummary,
  GitListBranchesArgs,
  GitCheckoutBranchArgs,
  GitPushArgs,
  GitUpstreamSyncStatus,
  GitRevertArgs,
  GitStashPushArgs,
  GitStashRefArgs,
  GitStashSummary,
  GitSyncArgs,
  GitHubStatus,
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
  AiPermissionMode,
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
  PrCheck,
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
  GetProcessLogTailArgs,
  GetTestLogTailArgs,
  ExportHistoryArgs,
  ExportHistoryResult,
  AgentChatApproveArgs,
  AgentChatClaudePermissionMode,
  AgentChatCreateArgs,
  AgentChatDeleteArgs,
  AgentChatDisposeArgs,
  AgentChatGetSummaryArgs,
  AgentChatHandoffArgs,
  AgentChatHandoffResult,
  AgentChatInterruptArgs,
  AgentChatListArgs,
  AgentChatModelInfo,
  AgentChatModelsArgs,
  AgentChatPermissionMode,
  AgentChatRespondToInputArgs,
  AgentChatResumeArgs,
  AgentChatSendArgs,
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
  AgentChatOpenCodePermissionMode,
  AgentChatUpdateSessionArgs,
  AgentChatSlashCommand,
  AgentChatSlashCommandsArgs,
  AgentChatFileSearchArgs,
  AgentChatFileSearchResult,
  AgentChatGetTurnFileDiffArgs,
  AgentTool,
  DeviceMarker,
  KeybindingOverride,
  KeybindingsSnapshot,
  ImportBranchLaneArgs,
  OnboardingDetectionResult,
  OnboardingExistingLaneCandidate,
  OnboardingStatus,
  OnboardingTourProgress,
  LaneListSnapshot,
  LaneRuntimeSummary,
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
  ContextGenerateDocsArgs,
  ContextGenerateDocsResult,
  ContextOpenDocArgs,
  ContextStatus,
  ProcessActionArgs,
  ProcessDefinition,
  ProcessRuntime,
  ProcessStackArgs,
  ProjectConfigCandidate,
  ProjectConfigDiff,
  ProjectConfigSnapshot,
  ProjectConfigTrust,
  ProjectConfigValidationResult,
  ProjectBrowseInput,
  ProjectBrowseResult,
  ProjectDetail,
  ProjectInfo,
  RecentProjectSummary,
  PtyCreateArgs,
  PtyCreateResult,
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
  MemoryHealthScope,
  MemoryHealthStats,
  SyncDesktopConnectionDraft,
  SyncDeviceRecord,
  SyncDeviceRuntimeState,
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
  CtoUpdateCoreMemoryArgs,
  CtoListSessionLogsArgs,
  CtoGetOpenclawStateResult,
  CtoUpdateOpenclawConfigArgs,
  CtoTestOpenclawConnectionArgs,
  CtoTestOpenclawConnectionResult,
  CtoListOpenclawMessagesArgs,
  CtoListOpenclawMessagesResult,
  CtoSendOpenclawMessageArgs,
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
  AgentCoreMemory,
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
  CtoGetAgentCoreMemoryArgs,
  CtoUpdateAgentCoreMemoryArgs,
  CtoListAgentSessionLogsArgs,
  CtoListAgentTaskSessionsArgs,
  CtoClearAgentTaskSessionArgs,
  CtoGetLinearOAuthSessionArgs,
  CtoGetLinearOAuthSessionResult,
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
  ComputerUseSettingsSnapshot,
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
import type { ContextDocService, ContextRefreshEventName } from "../context/contextDocService";
import type { createSessionService } from "../sessions/sessionService";
import type { SessionDeltaService } from "../sessions/sessionDeltaService";
import type { createPtyService } from "../pty/ptyService";
import type { createDiffService } from "../diffs/diffService";
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
import type { createPrSummaryService } from "../prs/prSummaryService";
import type { createAgentChatService } from "../chat/agentChatService";
import type { createComputerUseArtifactBrokerService } from "../computerUse/computerUseArtifactBrokerService";
import {
  buildComputerUseOwnerSnapshot,
  buildComputerUseSettingsSnapshot,
  collectRequiredComputerUseKindsFromPhases,
} from "../computerUse/controlPlane";
import { readGlobalState, writeGlobalState, reorderRecentProjects } from "../state/globalState";
import type { createKeybindingsService } from "../keybindings/keybindingsService";
import type { createAgentToolsService } from "../agentTools/agentToolsService";
import type { createDevToolsService } from "../devTools/devToolsService";
import type { createOnboardingService } from "../onboarding/onboardingService";
import type { createAutomationService } from "../automations/automationService";
import type { createAutomationPlannerService } from "../automations/automationPlannerService";
import type { createAutomationIngressService } from "../automations/automationIngressService";
import { type createMissionService } from "../missions/missionService";
import type { createMissionPreflightService } from "../missions/missionPreflightService";

import type { createMissionBudgetService } from "../orchestrator/missionBudgetService";
import type { createOrchestratorService } from "../orchestrator/orchestratorService";
import type { createAiOrchestratorService } from "../orchestrator/aiOrchestratorService";
import { readCoordinatorCheckpoint } from "../orchestrator/missionStateDoc";
import type { createMemoryService } from "../memory/memoryService";
import type { createOpenclawBridgeService } from "../cto/openclawBridgeService";
import type { createBatchConsolidationService } from "../memory/batchConsolidationService";
import type { createMemoryLifecycleService } from "../memory/memoryLifecycleService";
import type { createMemoryBriefingService } from "../memory/memoryBriefingService";
import type { createMissionMemoryLifecycleService } from "../memory/missionMemoryLifecycleService";
import type { createEpisodicSummaryService } from "../memory/episodicSummaryService";
import type { createHumanWorkDigestService } from "../memory/humanWorkDigestService";
import type { createProceduralLearningService } from "../memory/proceduralLearningService";
import type { createSkillRegistryService } from "../memory/skillRegistryService";
import type { createEmbeddingService } from "../memory/embeddingService";
import type { createEmbeddingWorkerService } from "../memory/embeddingWorkerService";
import type { createCtoStateService } from "../cto/ctoStateService";
import type { createWorkerAgentService } from "../cto/workerAgentService";
import type { createWorkerRevisionService } from "../cto/workerRevisionService";
import type { createWorkerBudgetService } from "../cto/workerBudgetService";
import type { createWorkerHeartbeatService } from "../cto/workerHeartbeatService";
import type { createWorkerTaskSessionService } from "../cto/workerTaskSessionService";
import type { createLinearCredentialService } from "../cto/linearCredentialService";
import { createLinearOAuthService, type LinearOAuthService } from "../cto/linearOAuthService";
import type { createFlowPolicyService } from "../cto/flowPolicyService";
import type { createLinearRoutingService } from "../cto/linearRoutingService";
import type { createLinearIngressService } from "../cto/linearIngressService";
import type { createLinearSyncService } from "../cto/linearSyncService";
import type { createLinearIssueTracker } from "../cto/linearIssueTracker";
import type { createUsageTrackingService } from "../usage/usageTrackingService";
import type { createBudgetCapService } from "../usage/budgetCapService";
import type { createSyncHostService } from "../sync/syncHostService";
import type { createSyncService } from "../sync/syncService";
import type { createFeedbackReporterService } from "../feedback/feedbackReporterService";
import type { AdeProjectService } from "../projects/adeProjectService";
import type { ConfigReloadService } from "../projects/configReloadService";
import type { createAdeCliService } from "../cli/adeCliService";
import { getErrorMessage, isRecord, nowIso, resolvePathWithinRoot, toMemoryEntryDto } from "../shared/utils";
import { resolveAdeLayout } from "../../../shared/adeLayout";

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
  devToolsService: ReturnType<typeof createDevToolsService>;
  onboardingService: ReturnType<typeof createOnboardingService>;
  laneService: ReturnType<typeof createLaneService>;
  laneEnvironmentService: ReturnType<typeof createLaneEnvironmentService> | null;
  laneTemplateService: ReturnType<typeof createLaneTemplateService> | null;
  portAllocationService: ReturnType<typeof createPortAllocationService> | null;
  laneProxyService: ReturnType<typeof createLaneProxyService> | null;
  oauthRedirectService: ReturnType<typeof createOAuthRedirectService> | null;
  runtimeDiagnosticsService: ReturnType<typeof createRuntimeDiagnosticsService> | null;
  rebaseSuggestionService: ReturnType<typeof createRebaseSuggestionService> | null;
  autoRebaseService: ReturnType<typeof createAutoRebaseService> | null;
  sessionService: ReturnType<typeof createSessionService>;
  ptyService: ReturnType<typeof createPtyService>;
  diffService: ReturnType<typeof createDiffService>;
  fileService: ReturnType<typeof createFileService>;
  operationService: ReturnType<typeof createOperationService>;
  gitService: ReturnType<typeof createGitOperationsService>;
  conflictService: ReturnType<typeof createConflictService>;
  aiIntegrationService: ReturnType<typeof createAiIntegrationService>;
  agentChatService: ReturnType<typeof createAgentChatService>;
  computerUseArtifactBrokerService: ReturnType<typeof createComputerUseArtifactBrokerService>;
  githubService: ReturnType<typeof createGithubService>;
  prService: ReturnType<typeof createPrService>;
  prPollingService: ReturnType<typeof createPrPollingService>;
  queueLandingService: ReturnType<typeof createQueueLandingService>;
  issueInventoryService: ReturnType<typeof createIssueInventoryService>;
  prSummaryService: ReturnType<typeof createPrSummaryService>;
  jobEngine: ReturnType<typeof createJobEngine>;
  automationService: ReturnType<typeof createAutomationService>;
  automationPlannerService: ReturnType<typeof createAutomationPlannerService>;
  automationIngressService?: ReturnType<typeof createAutomationIngressService> | null;
  missionService: ReturnType<typeof createMissionService>;
  missionPreflightService: ReturnType<typeof createMissionPreflightService>;
  orchestratorService: ReturnType<typeof createOrchestratorService>;
  missionBudgetService: ReturnType<typeof createMissionBudgetService>;
  aiOrchestratorService: ReturnType<typeof createAiOrchestratorService>;
  contextDocService?: ContextDocService | null;
  projectConfigService: ReturnType<typeof createProjectConfigService>;
  processService: ReturnType<typeof createProcessService>;
  testService: ReturnType<typeof createTestService>;
  sessionDeltaService?: SessionDeltaService | null;
  memoryService?: ReturnType<typeof createMemoryService> | null;
  batchConsolidationService?: ReturnType<typeof createBatchConsolidationService> | null;
  memoryLifecycleService?: ReturnType<typeof createMemoryLifecycleService> | null;
  memoryBriefingService?: ReturnType<typeof createMemoryBriefingService> | null;
  missionMemoryLifecycleService?: ReturnType<typeof createMissionMemoryLifecycleService> | null;
  episodicSummaryService?: ReturnType<typeof createEpisodicSummaryService> | null;
  humanWorkDigestService?: ReturnType<typeof createHumanWorkDigestService> | null;
  proceduralLearningService?: ReturnType<typeof createProceduralLearningService> | null;
  skillRegistryService?: ReturnType<typeof createSkillRegistryService> | null;
  embeddingService?: ReturnType<typeof createEmbeddingService> | null;
  embeddingWorkerService?: ReturnType<typeof createEmbeddingWorkerService> | null;
  ctoStateService?: ReturnType<typeof createCtoStateService> | null;
  openclawBridgeService?: ReturnType<typeof createOpenclawBridgeService> | null;
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

function sessionStatusBucket(args: {
  status: string;
  lastOutputPreview: string | null | undefined;
  runtimeState?: string | null;
}): "running" | "awaiting-input" | "ended" {
  if (args.status === "running") {
    if (args.runtimeState === "waiting-input") return "awaiting-input";
    const preview = args.lastOutputPreview ?? "";
    if (/\b(?:waiting|awaiting)\b.{0,28}\b(?:input|confirmation|response|prompt)\b/i.test(preview)) {
      return "awaiting-input";
    }
    if (/\((?:y\/n|yes\/no)\)/i.test(preview) || /\[(?:y\/n|yes\/no)\]/i.test(preview)) {
      return "awaiting-input";
    }
    return "running";
  }
  return "ended";
}

function summarizeLaneRuntime(
  laneId: string,
  sessions: Array<{
    laneId: string;
    status: string;
    lastOutputPreview: string | null;
    runtimeState?: string | null;
  }>,
): LaneRuntimeSummary {
  let runningCount = 0;
  let awaitingInputCount = 0;
  let endedCount = 0;
  let sessionCount = 0;

  for (const session of sessions) {
    if (session.laneId !== laneId) continue;
    sessionCount += 1;
    const bucket = sessionStatusBucket(session);
    if (bucket === "running") runningCount += 1;
    else if (bucket === "awaiting-input") awaitingInputCount += 1;
    else endedCount += 1;
  }

  const bucket = awaitingInputCount > 0
    ? "awaiting-input"
    : runningCount > 0
      ? "running"
      : endedCount > 0
        ? "ended"
        : "none";

  return {
    bucket,
    runningCount,
    awaitingInputCount,
    endedCount,
    sessionCount,
  };
}

function buildLanePresenceByLaneId(syncService: ReturnType<typeof createSyncService> | null | undefined): Map<string, DeviceMarker[]> {
  const hostService = syncService?.getHostService?.() ?? null;
  const snapshot = hostService?.getLanePresenceSnapshot?.() ?? [];
  return new Map(snapshot.map((entry) => [entry.laneId, entry.devicesOpen] as const));
}

function decorateLaneSummaryWithPresence(
  lane: LaneSummary,
  devicesOpenByLaneId: Map<string, DeviceMarker[]>,
): LaneSummary {
  const devicesOpen = devicesOpenByLaneId.get(lane.id) ?? [];
  return { ...lane, devicesOpen: devicesOpen.length > 0 ? devicesOpen : undefined };
}

function decorateLaneSummariesWithPresence(
  lanes: LaneSummary[],
  devicesOpenByLaneId: Map<string, DeviceMarker[]>,
): LaneSummary[] {
  return lanes.map((lane) => decorateLaneSummaryWithPresence(lane, devicesOpenByLaneId));
}

async function enrichSessionsForLaneList(
  args: Pick<AppContext, "sessionService" | "ptyService" | "agentChatService">,
): Promise<TerminalSessionSummary[]> {
  let sessions = args.ptyService.enrichSessions(args.sessionService.list({}));
  let allChats: AgentChatSessionSummary[] = [];
  try {
    allChats = await args.agentChatService.listSessions(undefined, { includeIdentity: true });
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
}

async function buildLaneListSnapshots(
  args: Pick<AppContext, "laneService" | "sessionService" | "ptyService" | "agentChatService" | "rebaseSuggestionService" | "autoRebaseService" | "conflictService"> & {
    syncService?: ReturnType<typeof createSyncService> | null;
  },
  lanes: LaneSummary[],
): Promise<LaneListSnapshot[]> {
  const [sessions, rebaseSuggestions, autoRebaseStatuses, stateSnapshots, batchAssessment] = await Promise.all([
    enrichSessionsForLaneList(args),
    Promise.resolve(args.rebaseSuggestionService?.listSuggestions() ?? []).catch(() => []),
    Promise.resolve(args.autoRebaseService?.listStatuses() ?? []).catch(() => []),
    Promise.resolve(args.laneService.listStateSnapshots()).catch(() => []),
    args.conflictService?.getBatchAssessment({ lanes }).catch(() => null) ?? Promise.resolve(null),
  ]);

  const rebaseByLaneId = new Map(rebaseSuggestions.map((entry) => [entry.laneId, entry] as const));
  const autoRebaseByLaneId = new Map(autoRebaseStatuses.map((entry) => [entry.laneId, entry] as const));
  const stateByLaneId = new Map(stateSnapshots.map((entry) => [entry.laneId, entry] as const));
  const conflictByLaneId = new Map((batchAssessment?.lanes ?? []).map((entry) => [entry.laneId, entry] as const));
  const devicesOpenByLaneId = buildLanePresenceByLaneId(args.syncService);

  return lanes.map((lane) => ({
    lane: decorateLaneSummaryWithPresence(lane, devicesOpenByLaneId),
    runtime: summarizeLaneRuntime(lane.id, sessions),
    rebaseSuggestion: rebaseByLaneId.get(lane.id) ?? null,
    autoRebaseStatus: autoRebaseByLaneId.get(lane.id) ?? null,
    conflictStatus: conflictByLaneId.get(lane.id) ?? null,
    stateSnapshot: stateByLaneId.get(lane.id) ?? null,
    adoptableAttached: lane.laneType === "attached" && lane.archivedAt == null,
  }));
}

const AI_USAGE_FEATURE_KEYS: AiFeatureKey[] = [
  "narratives",
  "conflict_proposals",
  "commit_messages",
  "pr_descriptions",
  "terminal_summaries",
  "memory_consolidation",
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
      claude: false,
      codex: false,
      cursor: false,
    },
    models: {
      claude: [],
      codex: [],
      cursor: [],
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
  if (raw === "shell" || raw === "manual" || raw === "opencode") return raw;
  return "opencode";
}

type MemoryWriteScope = "user" | "project" | "lane" | "mission";
type MemoryScope = "project" | "agent" | "mission";

type MemoryHealthCountRow = {
  scope: string | null;
  tier: number | null;
  status: string | null;
  count: number | null;
};

type MemorySweepLogRow = {
  sweep_id: string;
  project_id: string;
  trigger_reason: string | null;
  started_at: string;
  completed_at: string;
  entries_decayed: number | null;
  entries_demoted: number | null;
  entries_promoted: number | null;
  entries_archived: number | null;
  entries_orphaned: number | null;
  duration_ms: number | null;
};

type MemoryConsolidationLogRow = {
  consolidation_id: string;
  project_id: string;
  trigger_reason: string | null;
  started_at: string;
  completed_at: string;
  clusters_found: number | null;
  entries_merged: number | null;
  entries_created: number | null;
  tokens_used: number | null;
  duration_ms: number | null;
};

const MEMORY_HEALTH_SCOPES = ["project", "agent", "mission"] as const;
const MEMORY_HEALTH_LIMITS: Record<MemoryHealthScope, number> = {
  project: 2000,
  agent: 500,
  mission: 200,
};

function normalizeMemoryWriteScope(rawScope: string): MemoryWriteScope | undefined {
  const trimmed = rawScope.trim();
  if (trimmed === "agent") return "user";
  if (trimmed === "user" || trimmed === "project" || trimmed === "lane" || trimmed === "mission") return trimmed;
  return undefined;
}

function normalizeMemoryScope(rawScope: unknown): MemoryScope | undefined {
  const trimmed = typeof rawScope === "string" ? rawScope.trim() : "";
  if (trimmed === "project") return "project";
  if (trimmed === "agent" || trimmed === "user") return "agent";
  if (trimmed === "mission" || trimmed === "lane") return "mission";
  return undefined;
}
function normalizeMemoryHealthScope(rawScope: unknown): MemoryHealthScope | null {
  const trimmed = typeof rawScope === "string" ? rawScope.trim() : "";
  if (trimmed === "project") return "project";
  if (trimmed === "agent" || trimmed === "user") return "agent";
  if (trimmed === "mission" || trimmed === "lane") return "mission";
  return null;
}

type MemoryHealthModelStatus = MemoryHealthStats["embeddings"]["model"];

function createEmptyMemoryHealthStats(): MemoryHealthStats {
  const model: MemoryHealthModelStatus = {
    modelId: "Xenova/all-MiniLM-L6-v2",
    state: "idle",
    activity: "idle",
    installState: "missing",
    cacheDir: null,
    installPath: null,
    progress: null,
    loaded: null,
    total: null,
    file: null,
    error: null,
  };

  return {
    scopes: MEMORY_HEALTH_SCOPES.map((scope) => ({
      scope,
      current: 0,
      max: MEMORY_HEALTH_LIMITS[scope],
      counts: {
        tier1: 0,
        tier2: 0,
        tier3: 0,
        archived: 0,
      },
    })),
    lastSweep: null,
    lastConsolidation: null,
    embeddings: {
      entriesEmbedded: 0,
      entriesTotal: 0,
      queueDepth: 0,
      processing: false,
      lastBatchProcessedAt: null,
      cacheEntries: 0,
      cacheHits: 0,
      cacheMisses: 0,
      cacheHitRate: 0,
      model,
    },
  };
}

function getMemoryHealthStats(ctx: AppContext) {
  const stats = createEmptyMemoryHealthStats();
  const scopes = new Map(stats.scopes.map((entry) => [entry.scope, entry] as const));

  const rows = ctx.db.all<MemoryHealthCountRow>(
    `
      SELECT scope, tier, status, COUNT(*) AS count
      FROM unified_memories
      WHERE project_id = ?
      GROUP BY scope, tier, status
    `,
    [ctx.projectId],
  );

  for (const row of rows) {
    const scope = normalizeMemoryHealthScope(row.scope);
    if (!scope) continue;
    const target = scopes.get(scope);
    if (!target) continue;
    const count = Number(row.count ?? 0);
    if (!Number.isFinite(count) || count <= 0) continue;

    if (String(row.status ?? "").trim() === "archived") {
      target.counts.archived += count;
      continue;
    }

    const tier = Number(row.tier ?? 0);
    if (tier === 1) target.counts.tier1 += count;
    else if (tier === 2) target.counts.tier2 += count;
    else target.counts.tier3 += count;
  }

  for (const scope of stats.scopes) {
    scope.current = scope.counts.tier1 + scope.counts.tier2 + scope.counts.tier3;
  }

  const embeddingStatus = ctx.embeddingService?.getStatus();
  const embeddingWorkerStatus = ctx.embeddingWorkerService?.getStatus();
  const embeddedCountRow = ctx.db.get<{ count: number | null }>(
    `
      SELECT COUNT(*) AS count
      FROM unified_memories m
      WHERE m.project_id = ?
        AND m.status != 'archived'
        AND EXISTS (
          SELECT 1
          FROM unified_memory_embeddings e
          WHERE e.memory_id = m.id
        )
    `,
    [ctx.projectId],
  );
  const entriesEmbedded = Number(embeddedCountRow?.count ?? 0);
  const entriesTotal = stats.scopes.reduce((total, scope) => total + scope.current, 0);
  const cacheHits = Number(embeddingStatus?.cacheHits ?? 0);
  const cacheMisses = Number(embeddingStatus?.cacheMisses ?? 0);
  const cacheTotal = cacheHits + cacheMisses;

  stats.embeddings = {
    entriesEmbedded: Number.isFinite(entriesEmbedded) ? entriesEmbedded : 0,
    entriesTotal,
    queueDepth: Number(embeddingWorkerStatus?.queueDepth ?? 0),
    processing: embeddingWorkerStatus?.processing === true,
    lastBatchProcessedAt: embeddingWorkerStatus?.lastProcessedAt ?? null,
    cacheEntries: Number(embeddingStatus?.cacheEntries ?? 0),
    cacheHits,
    cacheMisses,
    cacheHitRate: cacheTotal > 0 ? cacheHits / cacheTotal : 0,
    model: {
      modelId: embeddingStatus?.modelId ?? "Xenova/all-MiniLM-L6-v2",
      state: embeddingStatus?.state ?? "idle",
      activity: embeddingStatus?.activity ?? "idle",
      installState: embeddingStatus?.installState ?? "missing",
      cacheDir: embeddingStatus?.cacheDir ?? null,
      installPath: embeddingStatus?.installPath ?? null,
      progress: embeddingStatus?.progress ?? null,
      loaded: embeddingStatus?.loaded ?? null,
      total: embeddingStatus?.total ?? null,
      file: embeddingStatus?.file ?? null,
      error: embeddingStatus?.error ?? null,
    },
  };

  const lastSweep = ctx.db.get<MemorySweepLogRow>(
    `
      SELECT sweep_id, project_id, trigger_reason, started_at, completed_at,
             entries_decayed, entries_demoted, entries_promoted, entries_archived,
             entries_orphaned, duration_ms
      FROM memory_sweep_log
      WHERE project_id = ?
      ORDER BY completed_at DESC
      LIMIT 1
    `,
    [ctx.projectId],
  );
  if (lastSweep) {
    stats.lastSweep = {
      sweepId: lastSweep.sweep_id,
      projectId: lastSweep.project_id,
      reason: lastSweep.trigger_reason === "startup" ? "startup" : "manual",
      startedAt: lastSweep.started_at,
      completedAt: lastSweep.completed_at,
      entriesDecayed: Number(lastSweep.entries_decayed ?? 0),
      entriesDemoted: Number(lastSweep.entries_demoted ?? 0),
      entriesPromoted: Number(lastSweep.entries_promoted ?? 0),
      entriesArchived: Number(lastSweep.entries_archived ?? 0),
      entriesOrphaned: Number(lastSweep.entries_orphaned ?? 0),
      durationMs: Number(lastSweep.duration_ms ?? 0),
    };
  }

  const lastConsolidation = ctx.db.get<MemoryConsolidationLogRow>(
    `
      SELECT consolidation_id, project_id, trigger_reason, started_at, completed_at,
             clusters_found, entries_merged, entries_created, tokens_used, duration_ms
      FROM memory_consolidation_log
      WHERE project_id = ?
      ORDER BY completed_at DESC
      LIMIT 1
    `,
    [ctx.projectId],
  );
  if (lastConsolidation) {
    stats.lastConsolidation = {
      consolidationId: lastConsolidation.consolidation_id,
      projectId: lastConsolidation.project_id,
      reason: lastConsolidation.trigger_reason === "auto" ? "auto" : "manual",
      startedAt: lastConsolidation.started_at,
      completedAt: lastConsolidation.completed_at,
      clustersFound: Number(lastConsolidation.clusters_found ?? 0),
      entriesMerged: Number(lastConsolidation.entries_merged ?? 0),
      entriesCreated: Number(lastConsolidation.entries_created ?? 0),
      tokensUsed: Number(lastConsolidation.tokens_used ?? 0),
      durationMs: Number(lastConsolidation.duration_ms ?? 0),
    };
  }

  return stats;
}

async function resolveFirstAvailableLaneId(
  ctx: AppContext,
  requestedLaneId: string | undefined | null
): Promise<string> {
  const laneId = typeof requestedLaneId === "string" ? requestedLaneId.trim() : "";
  if (laneId) return laneId;
  await ctx.laneService.ensurePrimaryLane().catch(() => {});
  const lanes = await ctx.laneService.list({ includeArchived: false, includeStatus: false });
  return (lanes.find((lane) => lane.laneType === "primary") ?? lanes[0])?.id ?? "";
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
    projectCount: undefined,
    projectPreview: undefined,
    checkedAt: nowIso(),
    authMode: credentialStatus.authMode,
    oauthAvailable: credentialStatus.oauthConfigured,
    tokenExpiresAt: credentialStatus.tokenExpiresAt,
    message: status.message,
  };
}

function summarizeProjectScan(result: OnboardingDetectionResult | null): Partial<{
  projectSummary: string;
  criticalConventions: string[];
  activeFocus: string[];
  notes: string[];
}> {
  if (!result) return {};
  const projectTypes = result.projectTypes.filter((entry) => entry.trim().length > 0);
  const signalFiles = result.indicators
    .slice(0, 4)
    .map((indicator) => indicator.file.trim())
    .filter((entry) => entry.length > 0);
  const workflowPaths = result.suggestedWorkflows
    .slice(0, 4)
    .map((workflow) => workflow.path.trim())
    .filter((entry) => entry.length > 0);

  return {
    projectSummary: `Detected ${projectTypes.join(", ") || "project"} setup from ${signalFiles.join(", ") || "repository signals"}.`,
    criticalConventions: projectTypes.map((type) => `${type} conventions`),
    activeFocus: projectTypes.length > 0 ? [`stabilize ${projectTypes[0]} workflows`] : [],
    notes: workflowPaths.length > 0 ? workflowPaths.map((workflow) => `Detected workflow: ${workflow}`) : [],
  };
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
  if (session.resumeMetadata?.targetId?.trim()) return false;
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

function mapPrAiPermissionMode(mode: AiPermissionMode): AgentChatPermissionMode {
  if (mode === "full_edit") return "full-auto";
  if (mode === "guarded_edit") return "edit";
  return "plan";
}

/**
 * Map an AiPermissionMode to provider-native permission fields for AgentChatCreateArgs.
 */
function mapPrAiPermissionModeToNativeFields(
  mode: AiPermissionMode,
  provider: string,
): Partial<Pick<AgentChatCreateArgs, "claudePermissionMode" | "codexApprovalPolicy" | "codexSandbox" | "opencodePermissionMode">> {
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
    if (legacy === "full-auto") return { codexApprovalPolicy: "never", codexSandbox: "danger-full-access" };
    if (legacy === "edit") return { codexApprovalPolicy: "on-failure", codexSandbox: "workspace-write" };
    return { codexApprovalPolicy: "untrusted", codexSandbox: "read-only" };
  }
  const umap: Record<string, AgentChatOpenCodePermissionMode> = {
    "full-auto": "full-auto",
    "edit": "edit",
    "plan": "plan",
  };
  return { opencodePermissionMode: umap[legacy] ?? "edit" };
}

function deriveAiPermissionModeFromSummary(
  summary: Pick<AgentChatSessionSummary, "provider" | "claudePermissionMode" | "codexApprovalPolicy" | "codexSandbox" | "opencodePermissionMode"> | null | undefined,
): AiPermissionMode | null {
  if (!summary) return null;
  if (summary.provider === "claude") {
    if (summary.claudePermissionMode === "bypassPermissions") return "full_edit";
    if (summary.claudePermissionMode === "acceptEdits") return "guarded_edit";
    if (summary.claudePermissionMode === "plan") return "read_only";
    if (summary.claudePermissionMode === "default") return "read_only";
    return null;
  }
  if (summary.provider === "codex") {
    if (summary.codexApprovalPolicy === "never" && summary.codexSandbox === "danger-full-access") return "full_edit";
    if (summary.codexApprovalPolicy === "on-failure") return "guarded_edit";
    if (summary.codexApprovalPolicy === "untrusted") return "read_only";
    return null;
  }
  if (summary.opencodePermissionMode === "full-auto") return "full_edit";
  if (summary.opencodePermissionMode === "edit") return "guarded_edit";
  if (summary.opencodePermissionMode === "plan") return "read_only";
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
  switchProjectFromDialog,
  closeCurrentProject,
  closeProjectByPath,
  globalStatePath
}: {
  getCtx: () => AppContext;
  switchProjectFromDialog: (selectedPath: string) => Promise<ProjectInfo>;
  closeCurrentProject: () => Promise<void>;
  closeProjectByPath: (projectRoot: string) => Promise<void>;
  globalStatePath: string;
}) {
  const watcherCleanupBoundSenders = new Set<number>();
  let linearOAuthService: LinearOAuthService | null = null;
  let linearOAuthServiceAdeDir: string | null = null;

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

  const traceIpcInvokes = !app.isPackaged || process.env.ADE_TRACE_IPC === "1";
  let ipcInvokeSeq = 0;

  const summarizeIpcValue = (value: unknown, depth = 0): unknown => {
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
      return Object.fromEntries(entries.map(([key, entryValue]) => [key, summarizeIpcValue(entryValue, depth + 1)]));
    }
    return typeof value;
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
  };

  const tracedIpcMain = ipcMain as TracedIpcMain;
  if (traceIpcInvokes && !tracedIpcMain.__adeTraceWrapped) {
    const originalHandle = tracedIpcMain.handle.bind(ipcMain);
    tracedIpcMain.__adeOriginalHandle = originalHandle;
    tracedIpcMain.handle = ((channel, listener) =>
      originalHandle(channel, async (event, ...args) => {
        const callId = ++ipcInvokeSeq;
        const startedAt = Date.now();
        const winId = BrowserWindow.fromWebContents(event.sender)?.id ?? null;
        const logger = getTraceLogger();
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
          args: summarizeIpcValue(args),
        });
        const IPC_TIMEOUT_MS = channel === IPC.contextGenerateDocs ? null : 30_000;
        try {
          const result = await (
            IPC_TIMEOUT_MS == null
              ? listener(event, ...args)
              : Promise.race([
                  listener(event, ...args),
                  new Promise<never>((_, reject) =>
                    setTimeout(
                      () => reject(new Error(`IPC handler for '${channel}' timed out after ${IPC_TIMEOUT_MS}ms (callId=${callId})`)),
                      IPC_TIMEOUT_MS
                    )
                  ),
                ])
          );
          logger.info("ipc.invoke.done", {
            callId,
            channel,
            winId,
            durationMs: Date.now() - startedAt,
            result: summarizeIpcValue(result),
          });
          return result;
        } catch (error) {
          logger.warn("ipc.invoke.failed", {
            callId,
            channel,
            winId,
            durationMs: Date.now() - startedAt,
            err: getErrorMessage(error),
          });
          throw error;
        }
      })) as typeof ipcMain.handle;
    tracedIpcMain.__adeTraceWrapped = true;
  }

  const triggerAutoContextDocs = (
    ctx: AppContext,
    args: { event: ContextRefreshEventName; reason: string }
  ): void => {
    if (!ctx.contextDocService) return;
    void ctx.contextDocService
      .maybeAutoRefreshDocs({
        event: args.event,
        reason: args.reason
      })
      .catch((error: unknown) => {
        ctx.logger.debug("ipc.context_docs_auto_refresh_failed", {
          event: args.event,
          reason: args.reason,
          error: error instanceof Error ? error.message : String(error)
        });
      });
  };

  const ensureComputerUseBroker = (): AppContext => {
    const ctx = getCtx();
    if (!ctx.computerUseArtifactBrokerService) {
      throw new Error("Computer-use artifact broker is not available.");
    }
    return ctx;
  };

  const resolveComputerUseOwnerSnapshotArgs = async (
    ctx: AppContext,
    args: ComputerUseOwnerSnapshotArgs,
  ): Promise<ComputerUseOwnerSnapshotArgs> => {
    if (args.owner.kind === "mission") {
      const mission = ctx.missionService.get(args.owner.id);
      return {
        ...args,
        policy: args.policy ?? mission?.computerUse ?? null,
        requiredKinds: args.requiredKinds?.length
          ? args.requiredKinds
          : collectRequiredComputerUseKindsFromPhases(mission?.phaseConfiguration?.selectedPhases ?? []),
      };
    }

    if (args.owner.kind === "chat_session") {
      const sessions = await ctx.agentChatService.listSessions();
      const session = sessions.find((candidate) => candidate.sessionId === args.owner.id) ?? null;
      return {
        ...args,
        policy: args.policy ?? session?.computerUse ?? null,
      };
    }

    return args;
  };

  type PrAiRuntimeSession = {
    sessionId: string;
    ptyId: string | null;
    runId: string;
    provider: "codex" | "claude";
    contextKey: string;
    context: PrAiResolutionContext;
    modelId: string;
    reasoning: string | null;
    permissionMode: AiPermissionMode;
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
    permissionMode: AiPermissionMode | null;
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

  ipcMain.handle(IPC.appRevealPath, async (_event, arg: { path: string }): Promise<void> => {
    const raw = typeof arg?.path === "string" ? arg.path.trim() : "";
    if (!raw) return;
    const normalized = path.resolve(raw);
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
    const normalized = path.resolve(raw);
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

  ipcMain.handle(
    IPC.appOpenPathInEditor,
    async (
      _event,
      arg: { rootPath: string; relativePath?: string; target: "finder" | "vscode" | "cursor" | "zed" }
    ): Promise<void> => {
      const rootRaw = typeof arg?.rootPath === "string" ? arg.rootPath.trim() : "";
      const relRaw = typeof arg?.relativePath === "string" ? arg.relativePath.trim() : "";
      const target = arg?.target;
      if (!rootRaw) throw new Error("Missing root path.");
      if (target !== "finder" && target !== "vscode" && target !== "cursor" && target !== "zed") {
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

      if (target === "finder") {
        shell.showItemInFolder(targetPath);
        return;
      }

      const launchDetached = async (command: string, args: string[]): Promise<void> => {
        await new Promise<void>((resolve, reject) => {
          let settled = false;
          try {
            const child = spawn(command, args, { detached: true, stdio: "ignore" });
            child.once("error", (error) => {
              if (settled) return;
              settled = true;
              reject(error);
            });
            child.once("spawn", () => {
              if (settled) return;
              settled = true;
              child.unref();
              resolve();
            });
          } catch (error) {
            reject(error);
          }
        });
      };

      const launchAttempts = async (attempts: Array<{ command: string; args: string[] }>): Promise<void> => {
        let lastError: unknown = null;
        for (const attempt of attempts) {
          try {
            await launchDetached(attempt.command, attempt.args);
            return;
          } catch (error) {
            lastError = error;
          }
        }
        throw lastError instanceof Error ? lastError : new Error("Failed to launch external editor.");
      };

      const attempts: Array<{ command: string; args: string[] }> = [];
      const cliCommand = target === "vscode" ? "code" : target === "cursor" ? "cursor" : "zed";

      if (process.platform === "darwin") {
        const appName = target === "vscode" ? "Visual Studio Code" : target === "cursor" ? "Cursor" : "Zed";
        attempts.push({ command: "open", args: ["-a", appName, targetPath] });
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
      }
    };
  });

  ipcMain.handle(IPC.projectOpenRepo, async (event): Promise<ProjectInfo | null> => {
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

  ipcMain.handle(
    IPC.projectGetDetail,
    async (_event, args: { rootPath: string }): Promise<ProjectDetail> => {
      const rootPath = typeof args?.rootPath === "string" ? args.rootPath.trim() : "";
      if (!rootPath) throw new Error("rootPath is required");
      return getProjectDetail(rootPath, { globalStatePath });
    }
  );

  ipcMain.handle(IPC.projectOpenAdeFolder, async (): Promise<void> => {
    const ctx = getCtx();
    await shell.openPath(ctx.adeDir);
  });

  ipcMain.handle(IPC.projectClearLocalData, async (_event, arg: ClearLocalAdeDataArgs = {}): Promise<ClearLocalAdeDataResult> => {
    const ctx = getCtx();
    const adePaths = ctx.adeProjectService?.paths;
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

    if (arg.packs) rmrf(adePaths?.artifactsDir ?? path.join(ctx.adeDir, "artifacts"));
    if (arg.logs) rmrf(adePaths?.logsDir ?? path.join(ctx.adeDir, "transcripts", "logs"));
    if (arg.transcripts) rmrf(adePaths?.transcriptsDir ?? path.join(ctx.adeDir, "transcripts"));

    return { deletedPaths, clearedAt };
  });

  ipcMain.handle(IPC.projectListRecent, async (): Promise<RecentProjectSummary[]> => {
    const state = readGlobalState(globalStatePath);
    return (state.recentProjects ?? []).map(toRecentProjectSummary);
  });

  ipcMain.handle(IPC.projectCloseCurrent, async (): Promise<void> => {
    await closeCurrentProject();
  });

  ipcMain.handle(IPC.projectForgetRecent, async (_event, arg: { rootPath: string }): Promise<RecentProjectSummary[]> => {
    const rootPath = typeof arg?.rootPath === "string" ? arg.rootPath.trim() : "";
    const state = readGlobalState(globalStatePath);
    if (!rootPath) {
      return (state.recentProjects ?? []).map(toRecentProjectSummary);
    }
    const filtered = (state.recentProjects ?? []).filter((entry) => entry.rootPath !== rootPath);
    const next = { ...state, recentProjects: filtered };
    if (next.lastProjectRoot === rootPath) {
      delete next.lastProjectRoot;
    }
    writeGlobalState(globalStatePath, next);
    try {
      await closeProjectByPath(rootPath);
    } catch {
      // Best effort; forgetting a project should still update recents even if teardown fails.
    }
    return filtered.map(toRecentProjectSummary);
  });

  ipcMain.handle(IPC.projectReorderRecent, async (_event, arg: { orderedPaths: string[] }): Promise<RecentProjectSummary[]> => {
    const orderedPaths = Array.isArray(arg?.orderedPaths) ? arg.orderedPaths.filter((p): p is string => typeof p === "string" && p.length > 0) : [];
    if (orderedPaths.length === 0) {
      const state = readGlobalState(globalStatePath);
      return (state.recentProjects ?? []).map(toRecentProjectSummary);
    }
    const state = readGlobalState(globalStatePath);
    const next = reorderRecentProjects(state, orderedPaths);
    writeGlobalState(globalStatePath, next);
    return (next.recentProjects ?? []).map(toRecentProjectSummary);
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

  ipcMain.handle(IPC.aiStoreApiKey, async (_event, arg: { provider: string; key: string }): Promise<void> => {
    const { storeApiKey } = await import("../ai/apiKeyStore");
    storeApiKey(arg.provider, arg.key);
  });

  ipcMain.handle(IPC.aiDeleteApiKey, async (_event, arg: { provider: string }): Promise<void> => {
    const { deleteApiKey } = await import("../ai/apiKeyStore");
    deleteApiKey(arg.provider);
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

  ipcMain.handle(IPC.syncGetStatus, async (): Promise<SyncRoleSnapshot> => {
    const ctx = getCtx();
    if (!ctx.syncService) {
      throw new Error("Sync service is not available.");
    }
    return await ctx.syncService.getStatus();
  });

  ipcMain.handle(IPC.syncRefreshDiscovery, async (): Promise<SyncRoleSnapshot> => {
    const ctx = getCtx();
    if (!ctx.syncService) {
      throw new Error("Sync service is not available.");
    }
    return await ctx.syncService.refreshDiscovery();
  });

  ipcMain.handle(IPC.syncListDevices, async (): Promise<SyncDeviceRuntimeState[]> => {
    const ctx = getCtx();
    if (!ctx.syncService) {
      throw new Error("Sync service is not available.");
    }
    return await ctx.syncService.listDevices();
  });

  ipcMain.handle(
    IPC.syncUpdateLocalDevice,
    async (
      _event,
      arg: { name?: string; deviceType?: SyncPeerDeviceType },
    ): Promise<SyncDeviceRecord> => {
      const ctx = getCtx();
      if (!ctx.syncService) {
        throw new Error("Sync service is not available.");
      }
      return await ctx.syncService.updateLocalDevice({
        name: typeof arg?.name === "string" ? arg.name : undefined,
        deviceType: arg?.deviceType,
      });
    },
  );

  ipcMain.handle(
    IPC.syncConnectToBrain,
    async (_event, arg: SyncDesktopConnectionDraft): Promise<SyncRoleSnapshot> => {
      const ctx = getCtx();
      if (!ctx.syncService) {
        throw new Error("Sync service is not available.");
      }
      return await ctx.syncService.connectToBrain(arg);
    },
  );

  ipcMain.handle(IPC.syncDisconnectFromBrain, async (): Promise<SyncRoleSnapshot> => {
    const ctx = getCtx();
    if (!ctx.syncService) {
      throw new Error("Sync service is not available.");
    }
    return await ctx.syncService.disconnectFromBrain();
  });

  ipcMain.handle(IPC.syncForgetDevice, async (_event, arg: { deviceId: string }): Promise<SyncRoleSnapshot> => {
    const ctx = getCtx();
    if (!ctx.syncService) {
      throw new Error("Sync service is not available.");
    }
    return await ctx.syncService.forgetDevice(typeof arg?.deviceId === "string" ? arg.deviceId : "");
  });

  ipcMain.handle(IPC.syncGetTransferReadiness, async (): Promise<SyncTransferReadiness> => {
    const ctx = getCtx();
    if (!ctx.syncService) {
      throw new Error("Sync service is not available.");
    }
    return await ctx.syncService.getTransferReadiness();
  });

  ipcMain.handle(IPC.syncTransferBrainToLocal, async (): Promise<SyncRoleSnapshot> => {
    const ctx = getCtx();
    if (!ctx.syncService) {
      throw new Error("Sync service is not available.");
    }
    return await ctx.syncService.transferBrainToLocal();
  });

  ipcMain.handle(IPC.syncGetPin, async (): Promise<{ pin: string | null }> => {
    const ctx = getCtx();
    if (!ctx.syncService) {
      throw new Error("Sync service is not available.");
    }
    return { pin: ctx.syncService.getPin() };
  });

  ipcMain.handle(IPC.syncSetPin, async (_event, pin: string): Promise<SyncRoleSnapshot> => {
    const ctx = getCtx();
    if (!ctx.syncService) {
      throw new Error("Sync service is not available.");
    }
    return await ctx.syncService.setPin(typeof pin === "string" ? pin : "");
  });

  ipcMain.handle(IPC.syncClearPin, async (): Promise<SyncRoleSnapshot> => {
    const ctx = getCtx();
    if (!ctx.syncService) {
      throw new Error("Sync service is not available.");
    }
    return await ctx.syncService.clearPin();
  });

  ipcMain.handle(
    IPC.syncSetActiveLanePresence,
    async (_event, arg: { laneIds?: string[] | null }): Promise<void> => {
      const ctx = getCtx();
      if (!ctx.syncService) {
        throw new Error("Sync service is not available.");
      }
      await ctx.syncService.setActiveLanePresence(
        Array.isArray(arg?.laneIds) ? arg.laneIds : [],
      );
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
    glossaryTermsSeen: [],
  });

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
      try { dashboard = ctx.missionService.getDashboard(); } catch { /* best-effort */ }

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
        runGraph = graph;
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
          triggerAutoContextDocs(ctx, {
            event: "mission_start",
            reason: `missions_create_autostart:${created.id}`
          });
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
    return ctx.orchestratorService.listRuns(arg);
  });

  ipcMain.handle(IPC.orchestratorGetRunGraph, async (_event, arg: GetOrchestratorRunGraphArgs): Promise<OrchestratorRunGraph> => {
    const ctx = getCtx();
    return ctx.orchestratorService.getRunGraph(arg);
  });

  ipcMain.handle(
    IPC.orchestratorStartRun,
    async (_event, arg: StartOrchestratorRunArgs): Promise<{ run: OrchestratorRun; steps: OrchestratorStep[] }> => {
      const ctx = getCtx();
      return ctx.orchestratorService.startRun(arg);
    }
  );

  ipcMain.handle(
    IPC.orchestratorStartRunFromMission,
    async (_event, arg: StartOrchestratorRunFromMissionArgs): Promise<{ run: OrchestratorRun; steps: OrchestratorStep[] }> => {
      const ctx = getCtx();
      triggerAutoContextDocs(ctx, {
        event: "mission_start",
        reason: `orchestrator_start_run_from_mission:${arg.missionId}`
      });
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
      return started.started;
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
    return ctx.orchestratorService.tick(arg);
  });

  ipcMain.handle(IPC.orchestratorPauseRun, async (_event, arg: PauseOrchestratorRunArgs): Promise<OrchestratorRun> => {
    const ctx = getCtx();
    return ctx.orchestratorService.pauseRun({
      runId: arg.runId,
      reason: arg.reason ?? "Paused from Missions UI.",
    });
  });

  ipcMain.handle(IPC.orchestratorResumeRun, async (_event, arg: ResumeOrchestratorRunArgs): Promise<OrchestratorRun> => {
    const ctx = getCtx();
    return ctx.aiOrchestratorService.resumeRun(arg);
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
    triggerAutoContextDocs(ctx, { event: "mission_end", reason: `orchestrator_cancel_run:${arg.runId}` });
    return run;
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
      triggerAutoContextDocs(ctx, {
        event: "mission_start",
        reason: `orchestrator_start_mission_run:${arg.missionId}`
      });
      return ctx.aiOrchestratorService.startMissionRun(arg);
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
      const result = ctx.orchestratorService.finalizeRun(arg);
      triggerAutoContextDocs(ctx, { event: "mission_end", reason: `orchestrator_finalize_run:${arg.runId}` });
      return result;
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
      return ctx.aiOrchestratorService.getChat(arg);
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
      return ctx.aiOrchestratorService.getThreadMessages(arg);
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
      return ctx.aiOrchestratorService.getGlobalChat(arg);
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
    const devicesOpenByLaneId = buildLanePresenceByLaneId(ctx.syncService);
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
        return await buildLaneListSnapshots(ctx, lanes);
      },
      {
        includeArchived: Boolean(arg?.includeArchived),
        includeStatus: arg?.includeStatus !== false,
      }
    );
  });

  ipcMain.handle(IPC.lanesCreate, async (_event, arg: CreateLaneArgs): Promise<LaneSummary> => {
    const ctx = getCtx();
    const lane = await ctx.laneService.create({ name: arg.name, description: arg.description, parentLaneId: arg.parentLaneId });
    await ensureLanePortLease(ctx, lane.id);
    notifyLaneCreated(ctx, lane);
    triggerAutoContextDocs(ctx, {
      event: "lane_create",
      reason: `lanes_create:${lane.id}`,
    });
    return lane;
  });

  ipcMain.handle(IPC.lanesCreateChild, async (_event, arg: CreateChildLaneArgs): Promise<LaneSummary> => {
    const ctx = getCtx();
    const lane = await ctx.laneService.createChild(arg);
    await ensureLanePortLease(ctx, lane.id);
    notifyLaneCreated(ctx, lane);
    triggerAutoContextDocs(ctx, {
      event: "lane_create",
      reason: `lanes_create_child:${lane.id}`,
    });
    return lane;
  });

  ipcMain.handle(IPC.lanesCreateFromUnstaged, async (_event, arg: CreateLaneFromUnstagedArgs): Promise<LaneSummary> => {
    const ctx = getCtx();
    const lane = await ctx.laneService.createFromUnstaged(arg);
    await ensureLanePortLease(ctx, lane.id);
    notifyLaneCreated(ctx, lane);
    triggerAutoContextDocs(ctx, {
      event: "lane_create",
      reason: `lanes_create_from_unstaged:${lane.id}`,
    });
    return lane;
  });

  ipcMain.handle(IPC.lanesImportBranch, async (_event, arg: ImportBranchLaneArgs): Promise<LaneSummary> => {
    const ctx = getCtx();
    const lane = await ctx.laneService.importBranch(arg);
    await ensureLanePortLease(ctx, lane.id);
    notifyLaneCreated(ctx, lane);
    triggerAutoContextDocs(ctx, {
      event: "lane_create",
      reason: `lanes_import_branch:${lane.id}`,
    });
    return lane;
  });

  ipcMain.handle(IPC.lanesAttach, async (_event, arg: AttachLaneArgs): Promise<LaneSummary> => {
    const ctx = getCtx();
    const lane = await ctx.laneService.attach(arg);
    await ensureLanePortLease(ctx, lane.id);
    notifyLaneCreated(ctx, lane);
    triggerAutoContextDocs(ctx, {
      event: "lane_create",
      reason: `lanes_attach:${lane.id}`,
    });
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
    triggerAutoContextDocs(ctx, {
      event: "lane_create",
      reason: `lanes_adopt_attached:${lane.id}`,
    });
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
    await ctx.laneService.delete(arg);
    ctx.portAllocationService?.release(arg.laneId);
    if (ctx.laneEnvironmentService && envContext?.envInitConfig) {
      try {
        await ctx.laneEnvironmentService.cleanupLaneEnvironment(envContext.lane, envContext.envInitConfig);
      } catch (error) {
        ctx.logger.warn("lane_env_cleanup.post_delete_failed", {
          laneId: envContext.lane.id,
          error: getErrorMessage(error)
        });
      }
    }
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
    return {
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
    const maxBytes = typeof arg.maxBytes === "number" ? Math.max(1024, Math.min(2_000_000, arg.maxBytes)) : 160_000;
    const raw = arg.raw === true;
    return ctx.sessionService.readTranscriptTail(session.transcriptPath, maxBytes, {
      raw,
      alignToLineBoundary: raw
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

  ipcMain.handle(IPC.agentChatInterrupt, async (_event, arg: AgentChatInterruptArgs): Promise<void> => {
    const ctx = getCtx();
    await ctx.agentChatService.interrupt(arg);
  });

  ipcMain.handle(IPC.agentChatResume, async (_event, arg: AgentChatResumeArgs): Promise<AgentChatSession> => {
    const ctx = getCtx();
    return await ctx.agentChatService.resumeSession(arg);
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

  ipcMain.handle(IPC.agentChatDispose, async (_event, arg: AgentChatDisposeArgs): Promise<void> => {
    const ctx = getCtx();
    await ctx.agentChatService.dispose(arg);
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
    const ctx = getCtx();
    const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
    const maxEncodedLength = Math.ceil(MAX_ATTACHMENT_BYTES / 3) * 4;
    if (typeof arg.data === "string" && arg.data.length > maxEncodedLength) {
      throw new Error("Temporary attachments must be 10 MB or smaller.");
    }
    const content = Buffer.from(arg.data, "base64");
    if (content.byteLength > MAX_ATTACHMENT_BYTES) {
      throw new Error("Temporary attachments must be 10 MB or smaller.");
    }
    // Save within the project's .ade directory so CLI subprocesses (Claude Code)
    // have filesystem access. Fall back to system temp if no project is open.
    const baseDir = ctx.project?.rootPath
      ? path.join(ctx.project.rootPath, ".ade", "attachments")
      : path.join(app.getPath("temp"), "ade-attachments");
    fs.mkdirSync(baseDir, { recursive: true });
    const ext = path.extname(arg.filename) || ".png";
    const destPath = path.join(baseDir, `${randomUUID()}${ext}`);
    fs.writeFileSync(destPath, content);
    return { path: destPath };
  });

  ipcMain.handle(IPC.agentChatGetTurnFileDiff, async (_event, arg: AgentChatGetTurnFileDiffArgs) => {
    const ctx = getCtx();
    const cwd = ctx.project?.rootPath;
    if (!cwd) throw new Error("No project root");
    const lang = arg.filePath.split(".").pop() ?? undefined;
    const origResult = await runGit(["show", `${arg.beforeSha}:${arg.filePath}`], { cwd, timeoutMs: 10_000 }).catch(() => ({ stdout: "", exitCode: 1 }));
    const modResult = await runGit(["show", `${arg.afterSha}:${arg.filePath}`], { cwd, timeoutMs: 10_000 }).catch(() => ({ stdout: "", exitCode: 1 }));
    return {
      path: arg.filePath,
      mode: "commit",
      language: lang,
      original: { text: origResult.exitCode === 0 ? origResult.stdout : null },
      modified: { text: modResult.exitCode === 0 ? modResult.stdout : null },
    };
  });

  ipcMain.handle(IPC.computerUseGetSettings, async (): Promise<ComputerUseSettingsSnapshot> => {
    const ctx = ensureComputerUseBroker();
    return buildComputerUseSettingsSnapshot({
      status: ctx.computerUseArtifactBrokerService.getBackendStatus(),
    });
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
      policy: resolved.policy,
      requiredKinds: resolved.requiredKinds,
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
    const ctx = getCtx();
    const projectRoot = ctx.project.rootPath;
    const layout = resolveAdeLayout(projectRoot);
    // Only allow files under artifactsDir — consistent with the ade-artifact:// protocol
    // handler in main.ts which validates exclusively against currentArtifactsDir.
    const allowedRoots = [layout.artifactsDir];

    let filePath = arg.uri;
    if (filePath.startsWith("file://")) {
      const { fileURLToPath } = await import("node:url");
      try { filePath = fileURLToPath(filePath); } catch { filePath = decodeURIComponent(filePath.replace(/^file:\/\//i, "")); }
    }
    if (!path.isAbsolute(filePath)) {
      filePath = path.resolve(projectRoot, filePath);
    }
    // Canonicalize and verify the resolved path is inside an allowed artifact root.
    const canonical = path.normalize(path.resolve(filePath));
    const inside = allowedRoots.some((root) => {
      try {
        resolvePathWithinRoot(root, canonical);
        return true;
      } catch {
        return false;
      }
    });
    if (!inside) return null;

    // Cap preview size to 10 MB to avoid loading arbitrarily large files into memory.
    const PREVIEW_SIZE_CAP = 10 * 1024 * 1024;
    try {
      const stat = await fs.promises.stat(canonical);
      if (!stat.isFile()) return null;
      if (stat.size > PREVIEW_SIZE_CAP) return null;
      const buf = await fs.promises.readFile(canonical);
      const ext = path.extname(canonical).replace(/^\./, "").toLowerCase();
      const mimeMap: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif", bmp: "image/bmp", svg: "image/svg+xml" };
      const mime = mimeMap[ext];
      if (!mime) return null;
      return `data:${mime};base64,${buf.toString("base64")}`;
    } catch {
      return null;
    }
  });

  ipcMain.handle(IPC.ptyCreate, async (_event, arg: PtyCreateArgs): Promise<PtyCreateResult> => {
    const ctx = getCtx();
    return await ctx.ptyService.create(arg);
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
    if (arg.sessionId) {
      triggerAutoContextDocs(ctx, {
        event: "session_end",
        reason: `pty_dispose:${arg.sessionId}`,
      });
    }
  });

  ipcMain.handle(IPC.diffGetChanges, async (_event, arg: GetDiffChangesArgs) => {
    const ctx = getCtx();
    return await ctx.diffService.getChanges(arg.laneId);
  });

  ipcMain.handle(IPC.diffGetFile, async (_event, arg: GetFileDiffArgs) => {
    const ctx = getCtx();
    return await ctx.diffService.getFileDiff({
      laneId: arg.laneId,
      filePath: arg.path,
      mode: arg.mode,
      compareRef: arg.compareRef,
      compareTo: arg.compareTo
    });
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
    return ctx.fileService.readFile(arg);
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
    const result = ctx.gitService.commit(arg);
    triggerAutoContextDocs(ctx, { event: "commit", reason: "git_commit" });
    return result;
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

  ipcMain.handle(IPC.contextGetStatus, async (): Promise<ContextStatus> => {
    const ctx = getCtx();
    if (!ctx.contextDocService) {
      throw new Error("Context doc service is not available.");
    }
    return ctx.contextDocService.getStatus();
  });

  ipcMain.handle(IPC.contextGenerateDocs, async (_event, arg: ContextGenerateDocsArgs): Promise<ContextGenerateDocsResult> => {
    const ctx = getCtx();
    if (!ctx.contextDocService) {
      throw new Error("Context doc service is not available.");
    }
    return ctx.contextDocService.generateDocs(arg);
  });

  ipcMain.handle(IPC.contextGetPrefs, async () => {
    const ctx = getCtx();
    if (!ctx.contextDocService) throw new Error("Context doc service is not available.");
    return ctx.contextDocService.getPrefs();
  });

  ipcMain.handle(IPC.contextSavePrefs, async (_event, arg) => {
    const ctx = getCtx();
    if (!ctx.contextDocService) throw new Error("Context doc service is not available.");
    return ctx.contextDocService.savePrefs(arg);
  });

  ipcMain.handle(IPC.contextOpenDoc, async (_event, arg: ContextOpenDocArgs): Promise<void> => {
    const ctx = getCtx();
    const explicitPath = typeof arg.path === "string" ? arg.path.trim() : "";
    const target = explicitPath || (arg.docId ? ctx.contextDocService?.getDocPath(arg.docId) ?? "" : "");
    if (!target) {
      throw new Error("contextOpenDoc requires docId or path");
    }
    await shell.openPath(target);
  });

  ipcMain.handle(IPC.githubGetStatus, async (): Promise<GitHubStatus> => {
    const ctx = getCtx();
    return await ctx.githubService.getStatus();
  });

  ipcMain.handle(IPC.githubSetToken, async (_event, arg: { token: string }): Promise<GitHubStatus> => {
    const ctx = getCtx();
    ctx.githubService.setToken(arg.token);
    return await ctx.githubService.getStatus();
  });

  ipcMain.handle(IPC.githubClearToken, async (): Promise<GitHubStatus> => {
    const ctx = getCtx();
    ctx.githubService.clearToken();
    return await ctx.githubService.getStatus();
  });

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
    const created = await ctx.prService.createFromLane(arg);
    triggerAutoContextDocs(ctx, {
      event: "pr_create",
      reason: `prs_create_from_lane:${created.id}`
    });
    return created;
  });

  ipcMain.handle(IPC.prsLinkToLane, async (_event, arg: LinkPrToLaneArgs): Promise<PrSummary> => {
    const ctx = getCtx();
    const linked = await ctx.prService.linkToLane(arg);
    triggerAutoContextDocs(ctx, {
      event: "pr_create",
      reason: `prs_link_to_lane:${linked.id}`
    });
    return linked;
  });

  const ensurePrPolling = () => {
    const ctx = getCtx();
    ctx.prPollingService.start();
    return ctx;
  };

  ipcMain.handle(IPC.prsGetForLane, async (_event, arg: { laneId: string }): Promise<PrSummary | null> => {
    const ctx = getCtx();
    return ctx.prService.getForLane(arg.laneId);
  });

  ipcMain.handle(IPC.prsListAll, async (): Promise<PrSummary[]> => {
    const ctx = ensurePrPolling();
    return ctx.prService.listAll();
  });

  ipcMain.handle(IPC.prsRefresh, async (_event, arg: { prId?: string; prIds?: string[] } = {}): Promise<PrSummary[]> => {
    const ctx = ensurePrPolling();
    return await ctx.prService.refresh(arg);
  });

  ipcMain.handle(IPC.prsGetStatus, async (_event, arg: { prId: string }): Promise<PrStatus | null> => {
    const ctx = ensurePrPolling();
    try {
      return await ctx.prService.getStatus(arg.prId);
    } catch (err) {
      // Return null for stale/deleted PR IDs instead of crashing
      if (err instanceof Error && err.message.includes("PR not found")) return null;
      throw err;
    }
  });

  ipcMain.handle(IPC.prsGetChecks, async (_event, arg: { prId: string }): Promise<PrCheck[]> => {
    const ctx = ensurePrPolling();
    try {
      return await ctx.prService.getChecks(arg.prId);
    } catch (err) {
      if (err instanceof Error && err.message.includes("PR not found")) return [];
      throw err;
    }
  });

  ipcMain.handle(IPC.prsGetComments, async (_event, arg: { prId: string }): Promise<PrComment[]> => {
    const ctx = ensurePrPolling();
    try {
      return await ctx.prService.getComments(arg.prId);
    } catch (err) {
      if (err instanceof Error && err.message.includes("PR not found")) return [];
      throw err;
    }
  });

  ipcMain.handle(IPC.prsGetReviews, async (_event, arg: { prId: string }): Promise<PrReview[]> => {
    const ctx = ensurePrPolling();
    try {
      return await ctx.prService.getReviews(arg.prId);
    } catch (err) {
      if (err instanceof Error && err.message.includes("PR not found")) return [];
      throw err;
    }
  });

  ipcMain.handle(IPC.prsGetReviewThreads, async (_event, arg: { prId: string }): Promise<PrReviewThread[]> => {
    const ctx = ensurePrPolling();
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
    triggerAutoContextDocs(ctx, {
      event: "pr_create",
      reason: `prs_update_description:${arg.prId}`
    });
  });

  ipcMain.handle(IPC.prsDelete, async (_event, arg: DeletePrArgs): Promise<DeletePrResult> => {
    const ctx = getCtx();
    const deleted = await ctx.prService.delete(arg);
    triggerAutoContextDocs(ctx, {
      event: "pr_create",
      reason: `prs_delete:${arg.prId}`
    });
    return deleted;
  });

  ipcMain.handle(IPC.prsDraftDescription, async (_event, arg: DraftPrDescriptionArgs): Promise<{ title: string; body: string }> => {
    const ctx = getCtx();
    return await ctx.prService.draftDescription(arg);
  });

  ipcMain.handle(IPC.prsLand, async (_event, arg: LandPrArgs): Promise<LandResult> => {
    const ctx = getCtx();
    const landed = await ctx.prService.land(arg);
    triggerAutoContextDocs(ctx, {
      event: "pr_land",
      reason: `prs_land:${arg.prId}`
    });
    return landed;
  });

  ipcMain.handle(IPC.prsLandStack, async (_event, arg: LandStackArgs): Promise<LandResult[]> => {
    const ctx = getCtx();
    const landed = await ctx.prService.landStack(arg);
    triggerAutoContextDocs(ctx, {
      event: "pr_land",
      reason: `prs_land_stack:${arg.rootLaneId}`
    });
    return landed;
  });

  ipcMain.handle(IPC.prsOpenInGitHub, async (_event, arg: { prId: string }): Promise<void> => {
    const ctx = getCtx();
    return await ctx.prService.openInGitHub(arg.prId);
  });

  ipcMain.handle(IPC.prsCreateIntegration, async (_event, arg: CreateIntegrationPrArgs): Promise<CreateIntegrationPrResult> => {
    const ctx = getCtx();
    const created = await ctx.prService.createIntegrationPr(arg);
    triggerAutoContextDocs(ctx, {
      event: "pr_create",
      reason: `prs_create_integration:${arg.integrationLaneName}:${arg.baseBranch}`
    });
    return created;
  });

  ipcMain.handle(IPC.prsLandStackEnhanced, async (_event, arg: LandStackEnhancedArgs): Promise<LandResult[]> => {
    const ctx = getCtx();
    const landed = await ctx.prService.landStackEnhanced(arg);
    triggerAutoContextDocs(ctx, {
      event: "pr_land",
      reason: `prs_land_stack_enhanced:${arg.rootLaneId}`
    });
    return landed;
  });

  ipcMain.handle(IPC.prsGetConflictAnalysis, async (_event, arg: { prId: string }) => getCtx().prService.getConflictAnalysis(arg.prId));

  ipcMain.handle(IPC.prsGetMergeContext, async (_event, arg: { prId: string }): Promise<PrMergeContext> => getCtx().prService.getMergeContext(arg.prId));

  ipcMain.handle(IPC.prsListWithConflicts, async () => ensurePrPolling().prService.listWithConflicts());

  ipcMain.handle(IPC.prsGetGitHubSnapshot, async (_event, arg?: { force?: boolean }): Promise<GitHubPrSnapshot> =>
    await ensurePrPolling().prService.getGithubSnapshot({ force: arg?.force === true })
  );

  ipcMain.handle(IPC.prsCreateQueue, async (_event, arg: CreateQueuePrsArgs): Promise<CreateQueuePrsResult> => {
    const ctx = getCtx();
    const created = await ctx.prService.createQueuePrs(arg);
    triggerAutoContextDocs(ctx, {
      event: "pr_create",
      reason: `prs_create_queue:${arg.targetBranch ?? "queue"}`
    });
    return created;
  });

  ipcMain.handle(IPC.prsSimulateIntegration, async (_event, arg: SimulateIntegrationArgs): Promise<IntegrationProposal> => getCtx().prService.simulateIntegration(arg));

  ipcMain.handle(IPC.prsCommitIntegration, async (_event, arg: CommitIntegrationArgs): Promise<CreateIntegrationPrResult> => {
    const ctx = getCtx();
    const committed = await ctx.prService.commitIntegration(arg);
    triggerAutoContextDocs(ctx, {
      event: "pr_create",
      reason: `prs_commit_integration:${arg.proposalId}:${arg.integrationLaneName}`
    });
    return committed;
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
    const landed = await ctx.prService.landQueueNext(arg);
    triggerAutoContextDocs(ctx, {
      event: "pr_land",
      reason: `prs_land_queue_next:${arg.groupId}`
    });
    return landed;
  });

  ipcMain.handle(IPC.prsStartQueueAutomation, async (_event, arg) => {
    const ctx = getCtx();
    const state = await ctx.queueLandingService.startQueue(arg);
    triggerAutoContextDocs(ctx, {
      event: "pr_create",
      reason: `prs_start_queue_automation:${arg.groupId}`,
    });
    return state;
  });

  ipcMain.handle(IPC.prsPauseQueueAutomation, async (_event, arg) => getCtx().queueLandingService.pauseQueue(arg.queueId));

  ipcMain.handle(IPC.prsResumeQueueAutomation, async (_event, arg) => {
    const ctx = getCtx();
    const state = ctx.queueLandingService.resumeQueue(arg);
    triggerAutoContextDocs(ctx, {
      event: "pr_create",
      reason: `prs_resume_queue_automation:${arg.queueId}`,
    });
    return state;
  });

  ipcMain.handle(IPC.prsCancelQueueAutomation, async (_event, arg) => getCtx().queueLandingService.cancelQueue(arg.queueId));

  ipcMain.handle(IPC.prsReorderQueue, async (_event, arg: ReorderQueuePrsArgs): Promise<void> => {
    await getCtx().prService.reorderQueuePrs(arg);
  });

  ipcMain.handle(IPC.prsGetHealth, async (_event, arg: { prId: string }): Promise<PrHealth> => getCtx().prService.getPrHealth(arg.prId));

  ipcMain.handle(IPC.prsGetQueueState, async (_event, arg: { groupId: string }): Promise<QueueLandingState | null> =>
    getCtx().queueLandingService.getQueueStateByGroup(arg.groupId)
  );

  ipcMain.handle(IPC.prsListQueueStates, async (_event, arg = {}) => getCtx().queueLandingService.listQueueStates(arg));

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
    const permissionMode: AiPermissionMode = arg?.permissionMode ?? "guarded_edit";
    const reasoning = typeof arg?.reasoning === "string" && arg.reasoning.trim().length > 0
      ? arg.reasoning.trim()
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
        originSurface: context.sourceTab === "integration"
          ? "integration"
          : context.sourceTab === "rebase"
            ? "rebase"
            : context.sourceTab === "queue"
              ? "manual"
            : context.sourceTab === "normal"
              ? "manual"
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

  ipcMain.handle(IPC.prsGetDetail, (_e, args: { prId: string }) => getCtx().prService.getDetail(args.prId));
  ipcMain.handle(IPC.prsGetFiles, (_e, args: { prId: string }) => getCtx().prService.getFiles(args.prId));
  ipcMain.handle(IPC.prsGetActionRuns, (_e, args: { prId: string }) => getCtx().prService.getActionRuns(args.prId));
  ipcMain.handle(IPC.prsGetActivity, (_e, args: { prId: string }) => getCtx().prService.getActivity(args.prId));
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
  ipcMain.handle(IPC.prsGetDeployments, (_e, args: { prId: string }) => getCtx().prService.getDeployments(args.prId));
  ipcMain.handle(IPC.prsGetAiSummary, (_e, args: { prId: string }) => getCtx().prSummaryService.getSummary(args.prId));
  ipcMain.handle(IPC.prsRegenerateAiSummary, (_e, args: { prId: string }) => getCtx().prSummaryService.regenerateSummary(args.prId));
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

  ipcMain.handle(IPC.historyExportOperations, async (event, arg: ExportHistoryArgs): Promise<ExportHistoryResult> => {
    const ctx = getCtx();
    const format: "csv" | "json" = arg?.format === "csv" ? "csv" : "json";
    const laneId = typeof arg?.laneId === "string" && arg.laneId.trim().length > 0 ? arg.laneId.trim() : undefined;
    const kind = typeof arg?.kind === "string" && arg.kind.trim().length > 0 ? arg.kind.trim() : undefined;
    const status = arg?.status;

    const rows = ctx.operationService.list({
      laneId,
      kind,
      limit: typeof arg?.limit === "number" ? arg.limit : 1000
    });
    const filteredRows =
      status && status !== "all"
        ? rows.filter((row) => row.status === status)
        : rows;

    const exportedAt = nowIso();
    const projectSlug = ctx.project.displayName.replace(/[^a-zA-Z0-9._-]+/g, "_");
    const dateStamp = exportedAt.slice(0, 10);
    const defaultPath = path.join(ctx.project.rootPath, `ade-history-${projectSlug}-${dateStamp}.${format}`);

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
            rootPath: ctx.project.rootPath,
            displayName: ctx.project.displayName
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

  // ── Memory service IPC ──────────────────────────────────────────────

  ipcMain.handle(
    IPC.memoryAdd,
    async (
      _event,
      arg: {
        projectId?: string;
        scope?: "user" | "project" | "lane" | "mission" | "agent";
        scopeOwnerId?: string;
        category: "fact" | "preference" | "pattern" | "decision" | "gotcha" | "convention";
        content: string;
        importance?: "low" | "medium" | "high";
        sourceRunId?: string;
      }
    ) => {
      const ctx = getCtx();
      if (!ctx.memoryService) return null;
      const pid = arg?.projectId ?? ctx.projectId;
      const scope = normalizeMemoryWriteScope(typeof arg?.scope === "string" ? arg.scope : "") ?? "project";
      const content = typeof arg?.content === "string" ? arg.content.trim() : "";
      if (!content) {
        throw new Error("memory.add requires non-empty content.");
      }
      const category = arg?.category;
      if (!category) {
        throw new Error("memory.add requires category.");
      }
      const importance = arg?.importance === "low" || arg?.importance === "medium" || arg?.importance === "high"
        ? arg.importance
        : "medium";
      const scopeOwnerIdRaw = typeof arg?.scopeOwnerId === "string" ? arg.scopeOwnerId.trim() : "";
      const scopeOwnerId =
        scopeOwnerIdRaw.length > 0
          ? scopeOwnerIdRaw
          : scope === "mission" && typeof arg?.sourceRunId === "string" && arg.sourceRunId.trim().length > 0
            ? arg.sourceRunId.trim()
            : undefined;
      return ctx.memoryService.addMemory({
        projectId: pid,
        scope,
        ...(scopeOwnerId ? { scopeOwnerId } : {}),
        category,
        content,
        importance,
        ...(arg?.sourceRunId ? { sourceRunId: arg.sourceRunId } : {}),
      });
    }
  );

  ipcMain.handle(IPC.memoryPin, async (_event, arg: { id: string }) => {
    const ctx = getCtx();
    if (!ctx.memoryService) return;
    ctx.memoryService.pinMemory(arg.id);
  });

  ipcMain.handle(IPC.memoryUpdateCore, async (_event, arg: CtoUpdateCoreMemoryArgs): Promise<CtoSnapshot> => {
    const ctx = getCtx();
    if (!ctx.ctoStateService) {
      throw new Error("CTO state service is not available.");
    }
    return ctx.ctoStateService.updateCoreMemory(arg.patch ?? {});
  });

  ipcMain.handle(IPC.memoryGetBudget, async (_event, arg: { projectId?: string; level?: string; scope?: "user" | "project" | "lane" | "mission" | "agent"; scopeOwnerId?: string }) => {
    const ctx = getCtx();
    if (!ctx.memoryService) return [];
    const pid = arg?.projectId ?? ctx.projectId;
    const level = (arg?.level === "lite" || arg?.level === "standard" || arg?.level === "deep") ? arg.level : "standard";
    const scope = normalizeMemoryScope(typeof arg?.scope === "string" ? arg.scope : "");
    const scopeOwnerId = typeof arg?.scopeOwnerId === "string" && arg.scopeOwnerId.trim().length > 0
      ? arg.scopeOwnerId.trim()
      : undefined;
    return ctx.memoryService.getMemoryBudget(pid, level, {
      ...(scope ? { scope } : {}),
      ...(scopeOwnerId ? { scopeOwnerId } : {})
    });
  });

  ipcMain.handle(IPC.memoryGetCandidates, async (_event, arg: { projectId?: string; limit?: number }) => {
    const ctx = getCtx();
    if (!ctx.memoryService) return [];
    const pid = arg?.projectId ?? ctx.projectId;
    return ctx.memoryService.getCandidateMemories(pid, arg?.limit ?? 20);
  });

  ipcMain.handle(IPC.memoryPromote, async (_event, arg: { id: string }) => {
    const ctx = getCtx();
    if (!ctx.memoryService) return;
    ctx.memoryService.promoteMemory(arg.id);
  });

  ipcMain.handle(IPC.memoryArchive, async (_event, arg: { id: string }) => {
    const ctx = getCtx();
    if (!ctx.memoryService) return;
    ctx.memoryService.archiveMemory(arg.id);
  });

  ipcMain.handle(IPC.memoryPromoteMissionEntry, async (_event, arg: { id: string; missionId: string; runId?: string | null }) => {
    const ctx = getCtx();
    if (!ctx.missionMemoryLifecycleService) return null;
    return ctx.missionMemoryLifecycleService.promoteMissionMemoryEntry({
      memoryId: arg.id,
      missionId: arg.missionId,
    });
  });

  ipcMain.handle(
    IPC.memoryList,
    async (
      _event,
      arg: {
        scope?: "project" | "agent" | "mission";
        tier?: 1 | 2 | 3;
        status?: "candidate" | "promoted" | "archived" | "all";
        limit?: number;
      } = {},
    ) => {
      const ctx = getCtx();
      if (!ctx.memoryService) return [];
      const scope = normalizeMemoryScope(arg.scope);
      const status = arg.status === "all"
        ? (["promoted", "candidate", "archived"] as const)
        : arg.status === "candidate" || arg.status === "promoted" || arg.status === "archived"
          ? arg.status
          : undefined;
      const tiers = arg.tier === 1 || arg.tier === 2 || arg.tier === 3 ? [arg.tier] : undefined;

      return ctx.memoryService.listMemories({
        projectId: ctx.projectId,
        ...(scope ? { scope } : {}),
        ...(status ? { status } : {}),
        ...(tiers ? { tiers } : {}),
        limit: Math.max(1, Math.min(200, Math.floor(arg.limit ?? 100))),
      }).map((memory) => toMemoryEntryDto(memory));
    },
  );

  ipcMain.handle(IPC.memoryListMissionEntries, async (_event, arg: { missionId: string; runId?: string | null; status?: "candidate" | "promoted" | "archived" | "all" }) => {
    const ctx = getCtx();
    if (!ctx.missionMemoryLifecycleService) return [];
    return ctx.missionMemoryLifecycleService.listMissionEntries({
      projectId: ctx.projectId,
      missionId: arg.missionId,
      runId: arg.runId,
      status: arg.status ?? "all",
    }).map((memory) => toMemoryEntryDto(memory));
  });

  ipcMain.handle(IPC.memoryListProcedures, async (_event, arg: { status?: "candidate" | "promoted" | "archived" | "all"; scope?: "project" | "mission" | "agent"; query?: string } = {}) => {
    const ctx = getCtx();
    return ctx.proceduralLearningService?.listProcedures(arg) ?? [];
  });

  ipcMain.handle(IPC.memoryGetProcedureDetail, async (_event, arg: { id: string }) => {
    const ctx = getCtx();
    return ctx.proceduralLearningService?.getProcedureDetail(arg.id) ?? null;
  });

  ipcMain.handle(IPC.memoryExportProcedureSkill, async (_event, arg: { id: string; name?: string | null }) => {
    const ctx = getCtx();
    return ctx.skillRegistryService?.exportProcedureSkill(arg) ?? null;
  });

  ipcMain.handle(IPC.memoryListIndexedSkills, async () => {
    const ctx = getCtx();
    return ctx.skillRegistryService?.listIndexedSkills() ?? [];
  });

  ipcMain.handle(IPC.memoryReindexSkills, async (_event, arg: { paths?: string[] } = {}) => {
    const ctx = getCtx();
    return ctx.skillRegistryService?.reindexSkills(arg) ?? [];
  });

  ipcMain.handle(IPC.memorySyncKnowledge, async () => {
    const ctx = getCtx();
    return ctx.humanWorkDigestService?.syncKnowledge() ?? null;
  });

  ipcMain.handle(IPC.memoryGetKnowledgeSyncStatus, async () => {
    const ctx = getCtx();
    return ctx.humanWorkDigestService?.getKnowledgeSyncStatus() ?? {
      syncing: false,
      lastSeenHeadSha: null,
      currentHeadSha: null,
      diverged: false,
      lastDigestAt: null,
      lastDigestMemoryId: null,
      lastError: null,
    };
  });

  ipcMain.handle(
    IPC.memorySearch,
    async (
      _event,
      arg: {
        query: string;
        projectId?: string;
        scope?: "user" | "project" | "lane" | "mission" | "agent";
        scopeOwnerId?: string;
        limit?: number;
        mode?: "lexical" | "hybrid";
        status?: "promoted" | "candidate" | "archived" | "all";
      }
    ) => {
    const ctx = getCtx();
    if (!ctx.memoryService) return [];
    const pid = arg?.projectId ?? ctx.projectId;
    const scope = normalizeMemoryScope(typeof arg?.scope === "string" ? arg.scope : "");
    const scopeOwnerId = typeof arg?.scopeOwnerId === "string" && arg.scopeOwnerId.trim().length > 0
      ? arg.scopeOwnerId.trim()
      : undefined;
    const status = arg?.status === "all"
      ? (["promoted", "candidate", "archived"] as const)
      : (arg?.status === "promoted" || arg?.status === "candidate" || arg?.status === "archived")
        ? arg.status
        : "promoted";
    return ctx.memoryService.searchMemories(
      arg.query,
      pid,
      scope,
      arg?.limit ?? 10,
      status,
      scopeOwnerId,
      arg?.mode === "lexical" ? "lexical" : "hybrid",
    );
    }
  );

  ipcMain.handle(IPC.memoryHealthStats, async () => {
    const ctx = getCtx();
    return getMemoryHealthStats(ctx);
  });

  ipcMain.handle(IPC.memoryDownloadEmbeddingModel, async () => {
    const ctx = getCtx();
    if (!ctx.embeddingService?.preload) {
      throw new Error("Embedding service is not available.");
    }
    const embeddingStatus = ctx.embeddingService.getStatus();
    const localFilesOnly = embeddingStatus.installState === "installed" && embeddingStatus.state !== "unavailable";
    // When we're about to attempt a remote download and stale/corrupted files
    // exist on disk, clear them first so transformers.js re-downloads fresh
    // files instead of reloading the same broken artifacts from its FS cache.
    if (!localFilesOnly && embeddingStatus.installState !== "missing") {
      ctx.logger.info("memory.embedding.clearing_cache_for_repair", {
        installState: embeddingStatus.installState,
        state: embeddingStatus.state,
      });
      await ctx.embeddingService.clearCache();
    }
    void ctx.embeddingService.preload({ forceRetry: true, localFilesOnly }).catch(() => {
      // Health polling will pick up the unavailable state; the click itself should remain responsive.
    });
    return getMemoryHealthStats(ctx);
  });

  ipcMain.handle(IPC.memoryRunSweep, async () => {
    const ctx = getCtx();
    if (!ctx.memoryLifecycleService) {
      throw new Error("Memory lifecycle service is not available.");
    }
    return ctx.memoryLifecycleService.runSweep({ reason: "manual" });
  });

  ipcMain.handle(IPC.memoryRunConsolidation, async () => {
    const ctx = getCtx();
    if (!ctx.batchConsolidationService) {
      throw new Error("Batch consolidation service is not available.");
    }
    return ctx.batchConsolidationService.runConsolidation({ reason: "manual" });
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
    const laneId = await resolveFirstAvailableLaneId(ctx, arg.laneId);
    if (!laneId) {
      throw new Error("No active lane is available to host the CTO chat session.");
    }
    return ctx.agentChatService.ensureIdentitySession({
      identityKey: "cto",
      laneId,
      modelId: arg.modelId ?? null,
      reasoningEffort: arg.reasoningEffort ?? null,
    });
  });

  ipcMain.handle(IPC.ctoUpdateCoreMemory, async (_event, arg: CtoUpdateCoreMemoryArgs): Promise<CtoSnapshot> => {
    const ctx = getCtx();
    if (!ctx.ctoStateService) {
      throw new Error("CTO state service is not available.");
    }
    return ctx.ctoStateService.updateCoreMemory(arg.patch ?? {});
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
    const laneId = await resolveFirstAvailableLaneId(ctx, arg.laneId);
    if (!laneId) throw new Error("No lane available for agent session.");
    return ctx.agentChatService.ensureIdentitySession({
      identityKey: `agent:${arg.agentId}`,
      laneId,
      modelId: arg.modelId ?? null,
      reasoningEffort: arg.reasoningEffort ?? null,
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

  ipcMain.handle(IPC.ctoGetOpenclawState, async (): Promise<CtoGetOpenclawStateResult> => {
    const ctx = getCtx();
    if (!ctx.openclawBridgeService) throw new Error("OpenClaw bridge service is not available.");
    return ctx.openclawBridgeService.getState();
  });

  ipcMain.handle(IPC.ctoUpdateOpenclawConfig, async (_event, arg: CtoUpdateOpenclawConfigArgs): Promise<CtoGetOpenclawStateResult> => {
    const ctx = getCtx();
    if (!ctx.openclawBridgeService) throw new Error("OpenClaw bridge service is not available.");
    return await ctx.openclawBridgeService.updateConfig(arg.patch ?? {});
  });

  ipcMain.handle(IPC.ctoTestOpenclawConnection, async (_event, _arg: CtoTestOpenclawConnectionArgs = {}): Promise<CtoTestOpenclawConnectionResult> => {
    const ctx = getCtx();
    if (!ctx.openclawBridgeService) throw new Error("OpenClaw bridge service is not available.");
    return await ctx.openclawBridgeService.testConnection();
  });

  ipcMain.handle(IPC.ctoListOpenclawMessages, async (_event, arg: CtoListOpenclawMessagesArgs = {}): Promise<CtoListOpenclawMessagesResult> => {
    const ctx = getCtx();
    if (!ctx.openclawBridgeService) throw new Error("OpenClaw bridge service is not available.");
    return ctx.openclawBridgeService.listMessages(arg.limit ?? 40);
  });

  ipcMain.handle(IPC.ctoSendOpenclawMessage, async (_event, arg: CtoSendOpenclawMessageArgs): Promise<CtoListOpenclawMessagesResult[number]> => {
    const ctx = getCtx();
    if (!ctx.openclawBridgeService) throw new Error("OpenClaw bridge service is not available.");
    return await ctx.openclawBridgeService.sendMessage(arg);
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

  ipcMain.handle(IPC.ctoGetAgentCoreMemory, async (_event, arg: CtoGetAgentCoreMemoryArgs): Promise<AgentCoreMemory> => {
    const ctx = getCtx();
    if (!ctx.workerHeartbeatService) throw new Error("Worker heartbeat service is not available.");
    return ctx.workerHeartbeatService.getAgentCoreMemory(arg.agentId);
  });

  ipcMain.handle(IPC.ctoUpdateAgentCoreMemory, async (_event, arg: CtoUpdateAgentCoreMemoryArgs): Promise<AgentCoreMemory> => {
    const ctx = getCtx();
    if (!ctx.workerHeartbeatService) throw new Error("Worker heartbeat service is not available.");
    return ctx.workerHeartbeatService.updateAgentCoreMemory(arg.agentId, arg.patch ?? {});
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

  ipcMain.handle(IPC.ctoRunProjectScan, async (): Promise<CtoRunProjectScanResult> => {
    const ctx = getCtx();
    const detection = await ctx.onboardingService.detectDefaults().catch(() => null);
    const summary = summarizeProjectScan(detection);
    const coreMemoryPatch = {
      projectSummary: summary.projectSummary ?? "",
      criticalConventions: summary.criticalConventions ?? [],
      activeFocus: summary.activeFocus ?? [],
      notes: summary.notes ?? [],
    };

    if (ctx.ctoStateService) {
      ctx.ctoStateService.updateCoreMemory(coreMemoryPatch);
    }

    const createdMemoryIds: string[] = [];
    if (ctx.memoryService) {
      if (coreMemoryPatch.projectSummary) {
        createdMemoryIds.push(
          ctx.memoryService.addMemory({
            projectId: ctx.projectId,
            scope: "project",
            category: "fact",
            content: coreMemoryPatch.projectSummary,
            importance: "high",
          }).id
        );
      }
      for (const convention of coreMemoryPatch.criticalConventions) {
        createdMemoryIds.push(
          ctx.memoryService.addMemory({
            projectId: ctx.projectId,
            scope: "project",
            category: "convention",
            content: convention,
            importance: "medium",
          }).id
        );
      }
    }

    return {
      detection,
      coreMemoryPatch,
      createdMemoryIds,
    };
  });

  ipcMain.handle(IPC.updateCheckForUpdates, () => {
    getCtx().autoUpdateService?.checkForUpdates();
  });

  ipcMain.handle(IPC.updateGetState, () => {
    return getCtx().autoUpdateService?.getSnapshot() ?? createEmptyAutoUpdateSnapshot();
  });

  ipcMain.handle(IPC.updateQuitAndInstall, () => {
    getCtx().autoUpdateService?.quitAndInstall();
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
      const registry = ctx.syncService?.getDeviceRegistryService?.() ?? null;
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
