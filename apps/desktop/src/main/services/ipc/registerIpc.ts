import { app, BrowserWindow, clipboard, dialog, ipcMain, shell } from "electron";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { IPC } from "../../../shared/ipc";
import { getModelById } from "../../../shared/modelRegistry";
import type {
  ApplyConflictProposalArgs,
  BatchAssessmentResult,
  AttachLaneArgs,
  AdoptAttachedLaneArgs,
  AppInfo,
  ClearLocalAdeDataArgs,
  ClearLocalAdeDataResult,
  ArchiveLaneArgs,
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
  AddMissionArtifactArgs,
  AddMissionInterventionArgs,
  ConflictProposal,
  ConflictExternalResolverRunSummary,
  ConflictProposalPreview,
  ConflictOverlap,
  ConflictStatus,
  CreateLaneArgs,
  CreateChildLaneArgs,
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
  CommitIntegrationArgs,
  DeletePrArgs,
  DeletePrResult,
  IntegrationProposal,
  IntegrationResolutionState,
  CreateIntegrationLaneForProposalArgs,
  CreateIntegrationLaneForProposalResult,
  StartIntegrationResolutionArgs,
  StartIntegrationResolutionResult,
  RecheckIntegrationStepArgs,
  RecheckIntegrationStepResult,
  PrAiResolutionInputArgs,
  PrAiResolutionStartArgs,
  PrAiResolutionStartResult,
  PrAiResolutionStopArgs,
  PrAiResolutionEventPayload,
  PrAiResolutionContext,
  AiPermissionMode,
  LinkPrToLaneArgs,
  LandResult,
  LandStackEnhancedArgs,
  LandQueueNextArgs,
  PrCheck,
  PrComment,
  PrHealth,
  PrMergeContext,
  PrReview,
  PrStatus,
  PrSummary,
  QueueLandingState,
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
  AgentChatChangePermissionModeArgs,
  AgentChatCreateArgs,
  AgentChatDisposeArgs,
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
  ContextPackListArgs,
  ContextPackOption,
  ContextPackFetchArgs,
  ContextPackFetchResult,
  AgentTool,
  KeybindingOverride,
  KeybindingsSnapshot,
  ImportBranchLaneArgs,
  CiScanResult,
  CiImportRequest,
  CiImportResult,
  OnboardingDetectionResult,
  OnboardingExistingLaneCandidate,
  OnboardingStatus,
  LaneSummary,
  ListOperationsArgs,
  ListOverlapsArgs,
  ListLanesArgs,
  ListMissionsArgs,
  ListSessionsArgs,
  ListTestRunsArgs,
  MergeSimulationArgs,
  MergeSimulationResult,
  OperationRecord,
  PackExport,
  PackDeltaDigestArgs,
  PackDeltaDigestV1,
  PackEvent,
  PackHeadVersion,
  PackSummary,
  PackVersion,
  PackVersionSummary,
  Checkpoint,
  GetLaneExportArgs,
  GetProjectExportArgs,
  GetConflictExportArgs,
  ContextExportLevel,
  GetMissionPackArgs,
  RefreshMissionPackArgs,
  ContextGenerateDocsArgs,
  ContextGenerateDocsResult,
  ContextOpenDocArgs,
  ContextStatus,
  ListPackEventsSinceArgs,
  ProcessActionArgs,
  ProcessDefinition,
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
  RebaseRunEventPayload,
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
  TerminalProfilesSnapshot,
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
  MissionStatus,
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
  CtoGetStateArgs,
  CtoEnsureSessionArgs,
  CtoUpdateCoreMemoryArgs,
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
  AgentCoreMemory,
  AgentSessionLogEntry,
  AgentConfigRevision,
  AgentBudgetSnapshot,
  WorkerAgentRun,
  AgentTaskSession,
  CtoListAgentsArgs,
  CtoSaveAgentArgs,
  CtoRemoveAgentArgs,
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
  LinearConnectionStatus,
  CtoSetLinearTokenArgs,
  CtoFlowPolicyRevision,
  CtoSaveFlowPolicyArgs,
  CtoRollbackFlowPolicyRevisionArgs,
  CtoSimulateFlowRouteArgs,
  LinearRouteDecision,
  LinearSyncDashboard,
  LinearSyncQueueItem,
  CtoResolveLinearSyncQueueItemArgs,
  LinearSyncConfig,
  NormalizedLinearIssue,
  UsageSnapshot,
  BudgetCheckResult,
  BudgetCapScope,
  BudgetCapProvider,
  BudgetCapConfig,
} from "../../../shared/types";
import type { LaneEnvInitConfig, LaneOverlayOverrides, PortLease } from "../../../shared/types";
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
import type { ContextDocService } from "../context/contextDocService";
import type { createSessionService } from "../sessions/sessionService";
import type { SessionDeltaService } from "../sessions/sessionDeltaService";
import type { createPtyService } from "../pty/ptyService";
import type { createDiffService } from "../diffs/diffService";
import type { createFileService } from "../files/fileService";
import type { createProjectConfigService } from "../config/projectConfigService";
import type { createProcessService } from "../processes/processService";
import type { createTestService } from "../tests/testService";
import type { createGitOperationsService } from "../git/gitOperationsService";
import type { createPackService } from "../packs/packService";
import type { createOperationService } from "../history/operationService";
import type { createConflictService } from "../conflicts/conflictService";
import type { createJobEngine } from "../jobs/jobEngine";
import type { createAiIntegrationService } from "../ai/aiIntegrationService";
import type { createGithubService } from "../github/githubService";
import type { createPrService } from "../prs/prService";
import type { createPrPollingService } from "../prs/prPollingService";
import type { createQueueLandingService } from "../prs/queueLandingService";
import type { createQueueRehearsalService } from "../prs/queueRehearsalService";
import type { createAgentChatService } from "../chat/agentChatService";
import { readGlobalState, writeGlobalState, reorderRecentProjects } from "../state/globalState";
import type { createKeybindingsService } from "../keybindings/keybindingsService";
import type { createTerminalProfilesService } from "../terminalProfiles/terminalProfilesService";
import type { createAgentToolsService } from "../agentTools/agentToolsService";
import type { createOnboardingService } from "../onboarding/onboardingService";
import type { createCiService } from "../ci/ciService";
import type { createAutomationService } from "../automations/automationService";
import type { createAutomationPlannerService } from "../automations/automationPlannerService";
import { type createMissionService } from "../missions/missionService";
import type { createMissionPreflightService } from "../missions/missionPreflightService";

import type { createMissionBudgetService } from "../orchestrator/missionBudgetService";
import type { createOrchestratorService } from "../orchestrator/orchestratorService";
import type { createAiOrchestratorService } from "../orchestrator/aiOrchestratorService";
import { readCoordinatorCheckpoint } from "../orchestrator/missionStateDoc";
import type { createMemoryService } from "../memory/memoryService";
import type { createBatchConsolidationService } from "../memory/batchConsolidationService";
import type { createMemoryLifecycleService } from "../memory/memoryLifecycleService";
import type { createEmbeddingService } from "../memory/embeddingService";
import type { createEmbeddingWorkerService } from "../memory/embeddingWorkerService";
import type { createCtoStateService } from "../cto/ctoStateService";
import type { createWorkerAgentService } from "../cto/workerAgentService";
import type { createWorkerRevisionService } from "../cto/workerRevisionService";
import type { createWorkerBudgetService } from "../cto/workerBudgetService";
import type { createWorkerHeartbeatService } from "../cto/workerHeartbeatService";
import type { createWorkerTaskSessionService } from "../cto/workerTaskSessionService";
import type { createLinearCredentialService } from "../cto/linearCredentialService";
import type { createFlowPolicyService } from "../cto/flowPolicyService";
import type { createLinearRoutingService } from "../cto/linearRoutingService";
import type { createLinearSyncService } from "../cto/linearSyncService";
import type { createLinearIssueTracker } from "../cto/linearIssueTracker";
import type { createUsageTrackingService } from "../usage/usageTrackingService";
import type { createBudgetCapService } from "../usage/budgetCapService";
import { getErrorMessage, isRecord, nowIso } from "../shared/utils";

export type AppContext = {
  db: AdeDb;
  logger: Logger;
  project: ProjectInfo;
  hasUserSelectedProject: boolean;
  projectId: string;
  adeDir: string;
  disposeHeadWatcher: () => void;
  keybindingsService: ReturnType<typeof createKeybindingsService>;
  terminalProfilesService: ReturnType<typeof createTerminalProfilesService>;
  agentToolsService: ReturnType<typeof createAgentToolsService>;
  onboardingService: ReturnType<typeof createOnboardingService>;
  ciService: ReturnType<typeof createCiService>;
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
  githubService: ReturnType<typeof createGithubService>;
  prService: ReturnType<typeof createPrService>;
  prPollingService: ReturnType<typeof createPrPollingService>;
  queueLandingService: ReturnType<typeof createQueueLandingService>;
  queueRehearsalService: ReturnType<typeof createQueueRehearsalService>;
  jobEngine: ReturnType<typeof createJobEngine>;
  automationService: ReturnType<typeof createAutomationService>;
  automationPlannerService: ReturnType<typeof createAutomationPlannerService>;
  missionService: ReturnType<typeof createMissionService>;
  missionPreflightService: ReturnType<typeof createMissionPreflightService>;
  orchestratorService: ReturnType<typeof createOrchestratorService>;
  missionBudgetService: ReturnType<typeof createMissionBudgetService>;
  aiOrchestratorService: ReturnType<typeof createAiOrchestratorService>;
  packService: ReturnType<typeof createPackService>;
  contextDocService?: ContextDocService | null;
  projectConfigService: ReturnType<typeof createProjectConfigService>;
  processService: ReturnType<typeof createProcessService>;
  testService: ReturnType<typeof createTestService>;
  sessionDeltaService?: SessionDeltaService | null;
  memoryService?: ReturnType<typeof createMemoryService> | null;
  batchConsolidationService?: ReturnType<typeof createBatchConsolidationService> | null;
  memoryLifecycleService?: ReturnType<typeof createMemoryLifecycleService> | null;
  embeddingService?: ReturnType<typeof createEmbeddingService> | null;
  embeddingWorkerService?: ReturnType<typeof createEmbeddingWorkerService> | null;
  ctoStateService?: ReturnType<typeof createCtoStateService> | null;
  workerAgentService?: ReturnType<typeof createWorkerAgentService> | null;
  workerRevisionService?: ReturnType<typeof createWorkerRevisionService> | null;
  workerBudgetService?: ReturnType<typeof createWorkerBudgetService> | null;
  workerHeartbeatService?: ReturnType<typeof createWorkerHeartbeatService> | null;
  workerTaskSessionService?: ReturnType<typeof createWorkerTaskSessionService> | null;
  linearCredentialService?: ReturnType<typeof createLinearCredentialService> | null;
  linearIssueTracker?: ReturnType<typeof createLinearIssueTracker> | null;
  flowPolicyService?: ReturnType<typeof createFlowPolicyService> | null;
  linearRoutingService?: ReturnType<typeof createLinearRoutingService> | null;
  linearSyncService?: ReturnType<typeof createLinearSyncService> | null;
  usageTrackingService?: ReturnType<typeof createUsageTrackingService> | null;
  budgetCapService?: ReturnType<typeof createBudgetCapService> | null;
  mcpSocketServer?: import("node:net").Server;
  mcpSocketPath?: string;
};

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
  "pr_descriptions",
  "terminal_summaries",
  "memory_consolidation",
  "mission_planning",
  "orchestrator",
  "initial_context"
];


async function safeRefreshMissionPack(
  ctx: AppContext,
  missionId: string,
  reason: string,
): Promise<void> {
  try {
    await ctx.packService.refreshMissionPack({ missionId, reason });
  } catch (error) {
    ctx.logger.warn("packs.refresh_mission_pack_failed", {
      missionId,
      reason,
      error: getErrorMessage(error)
    });
  }
}

function normalizeAutopilotExecutor(value: unknown): OrchestratorExecutorKind {
  const raw = typeof value === "string" ? value.trim() : "";
  if (raw === "shell" || raw === "manual" || raw === "unified") return raw;
  return "unified";
}

function toRecentProjectSummary(entry: { rootPath: string; displayName: string; lastOpenedAt: string }): RecentProjectSummary {
  return {
    rootPath: entry.rootPath,
    displayName: entry.displayName,
    lastOpenedAt: entry.lastOpenedAt,
    exists: fs.existsSync(entry.rootPath)
  };
}

type MemoryScope = "user" | "project" | "lane" | "mission";
type MemoryHealthScope = "project" | "agent" | "mission";

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

function normalizeMemoryScope(rawScope: string): MemoryScope | undefined {
  const trimmed = rawScope.trim();
  if (trimmed === "agent") return "user";
  if (trimmed === "user" || trimmed === "project" || trimmed === "lane" || trimmed === "mission") return trimmed;
  return undefined;
}

function normalizeMemoryHealthScope(rawScope: unknown): MemoryHealthScope | null {
  const trimmed = typeof rawScope === "string" ? rawScope.trim() : "";
  if (trimmed === "project") return "project";
  if (trimmed === "agent" || trimmed === "user") return "agent";
  if (trimmed === "mission" || trimmed === "lane") return "mission";
  return null;
}

function createEmptyMemoryHealthStats() {
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
      model: {
        modelId: "Xenova/all-MiniLM-L6-v2",
        state: "idle" as const,
        progress: null,
        loaded: null,
        total: null,
        file: null,
        error: null,
      },
    },
  } as {
    scopes: Array<{
      scope: MemoryHealthScope;
      current: number;
      max: number;
      counts: {
        tier1: number;
        tier2: number;
        tier3: number;
        archived: number;
      };
    }>;
    lastSweep: {
      sweepId: string;
      projectId: string;
      reason: "manual" | "startup";
      startedAt: string;
      completedAt: string;
      entriesDecayed: number;
      entriesDemoted: number;
      entriesPromoted: number;
      entriesArchived: number;
      entriesOrphaned: number;
      durationMs: number;
    } | null;
    lastConsolidation: {
      consolidationId: string;
      projectId: string;
      reason: "manual" | "auto";
      startedAt: string;
      completedAt: string;
      clustersFound: number;
      entriesMerged: number;
      entriesCreated: number;
      tokensUsed: number;
      durationMs: number;
    } | null;
    embeddings: {
      entriesEmbedded: number;
      entriesTotal: number;
      queueDepth: number;
      processing: boolean;
      lastBatchProcessedAt: string | null;
      cacheEntries: number;
      cacheHits: number;
      cacheMisses: number;
      cacheHitRate: number;
      model: {
        modelId: string;
        state: "idle" | "loading" | "ready" | "unavailable";
        progress: number | null;
        loaded: number | null;
        total: number | null;
        file: string | null;
        error: string | null;
      };
    };
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
  const lanes = await ctx.laneService.list({ includeArchived: false, includeStatus: false });
  return lanes[0]?.id ?? "";
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
  if (!ctx.linearIssueTracker || !tokenStored) {
    return {
      tokenStored,
      connected: false,
      viewerId: null,
      viewerName: null,
      checkedAt: nowIso(),
      message: message ?? (tokenStored ? "Linear tracker service unavailable." : "Linear token not configured."),
    };
  }

  const status = await ctx.linearIssueTracker.getConnectionStatus();
  return {
    tokenStored,
    connected: status.connected,
    viewerId: status.viewerId,
    viewerName: status.viewerName,
    checkedAt: nowIso(),
    message: status.message,
  };
}


function isChatToolType(toolType: string | null | undefined): boolean {
  return toolType === "codex-chat" || toolType === "claude-chat" || toolType === "ai-chat";
}

function inferPrAiProvider(modelId: string): "codex" | "claude" {
  const descriptor = getModelById(modelId);
  return descriptor?.family === "anthropic" ? "claude" : "codex";
}

function collectPrAiSourceLaneIds(context: PrAiResolutionContext): string[] {
  const sourceLaneIds = new Set<string>();
  const add = (value: string | null | undefined) => {
    const normalized = typeof value === "string" ? value.trim() : "";
    if (normalized) sourceLaneIds.add(normalized);
  };
  add(context.sourceLaneId ?? null);
  add(context.laneId ?? null);
  return Array.from(sourceLaneIds);
}

function buildPrAiResolverCommand(
  provider: "codex" | "claude",
  opts: {
    promptFilePath: string;
    permissionMode: AiPermissionMode;
    model: string;
    reasoning?: string | null;
  }
): string {
  const q = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;
  const promptArg = `"$(cat ${q(opts.promptFilePath)})"`;

  if (provider === "claude") {
    const parts: string[] = ["claude"];
    if (opts.permissionMode === "full_edit") {
      parts.push("--dangerously-skip-permissions");
    } else if (opts.permissionMode === "guarded_edit") {
      parts.push("--permission-mode", "acceptEdits");
    } else {
      parts.push("--permission-mode", "plan");
    }
    parts.push("--model", opts.model);
    if (opts.reasoning) {
      parts.push("--reasoning-effort", opts.reasoning);
    }
    parts.push(promptArg);
    return parts.join(" ");
  }

  const parts: string[] = ["codex"];
  if (opts.permissionMode === "full_edit") {
    parts.push("--full-auto");
  } else if (opts.permissionMode === "guarded_edit") {
    parts.push("-c", "approval_policy=on-failure", "-c", "sandbox_mode=workspace-write");
  } else {
    parts.push("-c", "approval_policy=untrusted", "-c", "sandbox_mode=read-only");
  }
  parts.push("--model", opts.model);
  if (opts.reasoning) {
    parts.push("--reasoning-effort", opts.reasoning);
  }
  parts.push(promptArg);
  return parts.join(" ");
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

  const triggerAutoContextDocs = (
    ctx: AppContext,
    args: { trigger: "per_mission" | "per_pr" | "per_lane_refresh"; reason: string }
  ): void => {
    if (!ctx.contextDocService) return;
    void ctx.contextDocService
      .maybeAutoRefreshDocs({
        trigger: args.trigger,
        reason: args.reason
      })
      .catch((error: unknown) => {
        ctx.logger.debug("ipc.context_docs_auto_refresh_failed", {
          trigger: args.trigger,
          reason: args.reason,
          error: error instanceof Error ? error.message : String(error)
        });
      });
  };

  type PrAiRuntimeSession = {
    sessionId: string;
    ptyId: string;
    runId: string;
    provider: "codex" | "claude";
    context: PrAiResolutionContext;
    pollTimer: ReturnType<typeof setInterval> | null;
    finalizing: boolean;
  };

  const prAiSessions = new Map<string, PrAiRuntimeSession>();

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

  ipcMain.handle(IPC.appPing, async () => "pong" as const);

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
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error("Only http(s) URLs are allowed.");
    }
    await shell.openExternal(parsed.toString());
  });

  ipcMain.handle(IPC.appRevealPath, async (_event, arg: { path: string }): Promise<void> => {
    const raw = typeof arg?.path === "string" ? arg.path.trim() : "";
    if (!raw) return;
    // Basic path boundary validation — reject obvious traversal patterns
    const normalized = path.resolve(raw);
    if (normalized !== raw && raw.includes("..")) return;
    shell.showItemInFolder(normalized);
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
      const targetPath = relRaw ? path.resolve(rootPath, relRaw) : rootPath;
      const relToRoot = path.relative(rootPath, targetPath);
      if (relToRoot.startsWith("..") || path.isAbsolute(relToRoot)) {
        throw new Error("relativePath escapes rootPath.");
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

  ipcMain.handle(IPC.projectOpenAdeFolder, async (): Promise<void> => {
    const ctx = getCtx();
    await shell.openPath(ctx.adeDir);
  });

  ipcMain.handle(IPC.projectClearLocalData, async (_event, arg: ClearLocalAdeDataArgs = {}): Promise<ClearLocalAdeDataResult> => {
    const ctx = getCtx();
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

    if (arg.packs) rmrf(path.join(ctx.adeDir, "packs"));
    if (arg.logs) rmrf(path.join(ctx.adeDir, "logs"));
    if (arg.transcripts) rmrf(path.join(ctx.adeDir, "transcripts"));

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

  ipcMain.handle(IPC.keybindingsGet, async (): Promise<KeybindingsSnapshot> => {
    const ctx = getCtx();
    return ctx.keybindingsService.get();
  });

  ipcMain.handle(IPC.keybindingsSet, async (_event, arg: { overrides: KeybindingOverride[] }): Promise<KeybindingsSnapshot> => {
    const ctx = getCtx();
    return ctx.keybindingsService.set({ overrides: arg?.overrides ?? [] });
  });

  ipcMain.handle(IPC.aiGetStatus, async (): Promise<AiSettingsStatus> => {
    const ctx = getCtx();
    const status = await ctx.aiIntegrationService.getStatus();
    // Single query for all feature daily usage instead of N individual queries
    const usageBatch = ctx.aiIntegrationService.getDailyUsageBatch(AI_USAGE_FEATURE_KEYS);
    return {
      mode: status.mode,
      availableProviders: status.availableProviders,
      models: status.models,
      detectedAuth: status.detectedAuth,
      features: AI_USAGE_FEATURE_KEYS.map((feature) => ({
        feature,
        enabled: ctx.aiIntegrationService.getFeatureFlag(feature),
        dailyUsage: usageBatch.get(feature) ?? 0,
        dailyLimit: ctx.aiIntegrationService.getDailyBudgetLimit(feature)
      }))
    };
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
    const merged: AiConfig = {
      ...currentAi,
      ...partial,
      features: { ...currentAi.features, ...partial.features },
      taskRouting: { ...currentAi.taskRouting, ...partial.taskRouting },
      budgets: { ...currentAi.budgets, ...partial.budgets },
      featureModelOverrides: { ...currentAi.featureModelOverrides, ...partial.featureModelOverrides },
    };
    ctx.projectConfigService.save({
      shared: { ...snapshot.shared, ai: merged },
      local: snapshot.local ?? {},
    });
  });

  ipcMain.handle(IPC.agentToolsDetect, async (): Promise<AgentTool[]> => {
    const ctx = getCtx();
    return ctx.agentToolsService.detect();
  });

  ipcMain.handle(IPC.terminalProfilesGet, async (): Promise<TerminalProfilesSnapshot> => {
    const ctx = getCtx();
    return ctx.terminalProfilesService.get();
  });

  ipcMain.handle(IPC.terminalProfilesSet, async (_event, arg: TerminalProfilesSnapshot): Promise<TerminalProfilesSnapshot> => {
    const ctx = getCtx();
    return ctx.terminalProfilesService.set(arg);
  });

  ipcMain.handle(IPC.onboardingGetStatus, async (): Promise<OnboardingStatus> => {
    const ctx = getCtx();
    if (!ctx.onboardingService) {
      return { completedAt: null };
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

  ipcMain.handle(IPC.onboardingComplete, async (): Promise<OnboardingStatus> => {
    const ctx = getCtx();
    if (!ctx.onboardingService) {
      return { completedAt: null };
    }
    return ctx.onboardingService.complete();
  });

  ipcMain.handle(IPC.ciScan, async (): Promise<CiScanResult> => {
    const ctx = getCtx();
    return await ctx.ciService.scan();
  });

  ipcMain.handle(IPC.ciImport, async (_event, arg: CiImportRequest): Promise<CiImportResult> => {
    const ctx = getCtx();
    return await ctx.ciService.import(arg);
  });

  ipcMain.handle(IPC.automationsList, async (): Promise<AutomationRuleSummary[]> => {
    const ctx = getCtx();
    return ctx.automationService.list();
  });

  ipcMain.handle(IPC.automationsToggle, async (_event, arg: { id: string; enabled: boolean }): Promise<AutomationRuleSummary[]> => {
    const ctx = getCtx();
    return ctx.automationService.toggle({ id: arg?.id ?? "", enabled: Boolean(arg?.enabled) });
  });

  ipcMain.handle(IPC.automationsTriggerManually, async (_event, arg: { id: string; laneId?: string | null }): Promise<AutomationRun> => {
    const ctx = getCtx();
    return await ctx.automationService.triggerManually({ id: arg?.id ?? "", laneId: arg?.laneId ?? null });
  });

  ipcMain.handle(IPC.automationsGetHistory, async (_event, arg: { id: string; limit?: number }): Promise<AutomationRun[]> => {
    const ctx = getCtx();
    return ctx.automationService.getHistory({ id: arg?.id ?? "", limit: arg?.limit });
  });

  ipcMain.handle(IPC.automationsGetRunDetail, async (_event, arg: { runId: string }): Promise<AutomationRunDetail | null> => {
    const ctx = getCtx();
    return ctx.automationService.getRunDetail({ runId: arg?.runId ?? "" });
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
    async (_event, arg: import("../../../shared/types").GetFullMissionViewArgs): Promise<import("../../../shared/types").FullMissionViewResult> => {
      const ctx = getCtx();
      const missionId = typeof arg?.missionId === "string" ? arg.missionId.trim() : "";
      if (!missionId) return { mission: null, runGraph: null, artifacts: [], checkpoints: [], dashboard: null };

      let dashboard: import("../../../shared/types").MissionDashboardSnapshot | null = null;
      try { dashboard = ctx.missionService.getDashboard(); } catch { /* best-effort */ }

      const mission = await ctx.missionService.get(missionId);

      let runGraph: import("../../../shared/types").OrchestratorRunGraph | null = null;
      let artifacts: import("../../../shared/types").OrchestratorArtifact[] = [];
      let checkpoints: import("../../../shared/types").OrchestratorWorkerCheckpoint[] = [];

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
    const title =
      typeof arg?.title === "string" && arg.title.trim().length > 0
        ? arg.title.trim()
        : prompt.split(/\r?\n/).map((line) => line.trim()).find((line) => line.length > 0) ?? "Mission";
    const plannerEngine = arg?.plannerEngine ?? "auto";
    const laneId = typeof arg?.laneId === "string" && arg.laneId.trim().length > 0 ? arg.laneId.trim() : null;
    const executionMode = arg?.executionMode ?? "local";
    const targetMachineId = typeof arg?.targetMachineId === "string" ? arg.targetMachineId.trim() || null : null;
    const autostart = arg?.autostart !== false;
    const runMode = arg?.launchMode === "manual" ? "manual" : "autopilot";
    const defaultExecutorKind: OrchestratorExecutorKind = runMode === "manual"
      ? "manual"
      : normalizeAutopilotExecutor(arg?.autopilotExecutor ?? "unified");

    // Fast-path for autostart missions: create immediately and launch in the background
    // so renderer IPC does not block on planning/launch work.
    if (autostart) {
      const created = ctx.missionService.create({
        ...arg,
        launchMode: runMode,
        autostart: true,
        autopilotExecutor: defaultExecutorKind
      });

      await safeRefreshMissionPack(ctx, created.id, "mission_created");

      void (async () => {
        try {
          triggerAutoContextDocs(ctx, {
            trigger: "per_mission",
            reason: `missions_create_autostart:${created.id}`
          });
          const launch = await ctx.aiOrchestratorService.startMissionRun({
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
          ctx.logger.warn("missions.autostart_failed", {
            missionId: created.id,
            runMode,
            defaultExecutorKind,
            error: message
          });
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
    await safeRefreshMissionPack(ctx, created.id, "mission_created");

    const detail = ctx.missionService.get(created.id);
    if (detail) return detail;
    return created;
  });

  ipcMain.handle(IPC.missionsUpdate, async (_event, arg: UpdateMissionArgs): Promise<MissionDetail> => {
    const ctx = getCtx();
    const updated = ctx.missionService.update(arg);
    await safeRefreshMissionPack(ctx, updated.id, "mission_updated");
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
    await safeRefreshMissionPack(ctx, updated.missionId, "mission_step_updated");
    return updated;
  });

  ipcMain.handle(IPC.missionsAddArtifact, async (_event, arg: AddMissionArtifactArgs): Promise<MissionArtifact> => {
    const ctx = getCtx();
    const artifact = ctx.missionService.addArtifact(arg);
    await safeRefreshMissionPack(ctx, artifact.missionId, "mission_artifact_added");
    return artifact;
  });

  ipcMain.handle(
    IPC.missionsAddIntervention,
    async (_event, arg: AddMissionInterventionArgs): Promise<MissionIntervention> => {
      const ctx = getCtx();
      const intervention = ctx.missionService.addIntervention(arg);
      await safeRefreshMissionPack(ctx, intervention.missionId, "mission_intervention_added");
      return intervention;
    }
  );

  ipcMain.handle(
    IPC.missionsResolveIntervention,
    async (_event, arg: ResolveMissionInterventionArgs): Promise<MissionIntervention> => {
      const ctx = getCtx();
      const intervention = ctx.missionService.resolveIntervention(arg);
      await safeRefreshMissionPack(ctx, intervention.missionId, "mission_intervention_resolved");
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
        trigger: "per_mission",
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
    return ctx.orchestratorService.resumeRun(arg);
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
        trigger: "per_mission",
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
    return await withIpcTiming(
      ctx,
      "lanes.list",
      async () => await ctx.laneService.list(arg),
      {
        includeArchived: Boolean(arg?.includeArchived),
        includeStatus: arg?.includeStatus !== false
      }
    );
  });

  ipcMain.handle(IPC.lanesCreate, async (_event, arg: CreateLaneArgs): Promise<LaneSummary> => {
    const ctx = getCtx();
    const lane = await ctx.laneService.create({ name: arg.name, description: arg.description, parentLaneId: arg.parentLaneId });
    await ensureLanePortLease(ctx, lane.id);
    return lane;
  });

  ipcMain.handle(IPC.lanesCreateChild, async (_event, arg: CreateChildLaneArgs): Promise<LaneSummary> => {
    const ctx = getCtx();
    const lane = await ctx.laneService.createChild(arg);
    await ensureLanePortLease(ctx, lane.id);
    return lane;
  });

  ipcMain.handle(IPC.lanesImportBranch, async (_event, arg: ImportBranchLaneArgs): Promise<LaneSummary> => {
    const ctx = getCtx();
    const lane = await ctx.laneService.importBranch(arg);
    await ensureLanePortLease(ctx, lane.id);
    return lane;
  });

  ipcMain.handle(IPC.lanesAttach, async (_event, arg: AttachLaneArgs): Promise<LaneSummary> => {
    const ctx = getCtx();
    const lane = await ctx.laneService.attach(arg);
    await ensureLanePortLease(ctx, lane.id);
    return lane;
  });

  ipcMain.handle(IPC.lanesAdoptAttached, async (_event, arg: AdoptAttachedLaneArgs): Promise<LaneSummary> => {
    const ctx = getCtx();
    const lane = await ctx.laneService.adoptAttached(arg);
    await ensureLanePortLease(ctx, lane.id);
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
    ctx.laneService.archive(arg);
    ctx.portAllocationService?.release(arg.laneId);
  });

  ipcMain.handle(IPC.lanesDelete, async (_event, arg: DeleteLaneArgs): Promise<void> => {
    const ctx = getCtx();
    const envContext = ctx.laneEnvironmentService
      ? await resolveLaneOverlayContext(ctx, arg.laneId)
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
      await ctx.laneProxyService.start();
    }

    const expectedHostname = ctx.laneProxyService.generateHostname(laneId, lane.name);
    const currentRoute = ctx.laneProxyService.getRoute(laneId);
    if (
      !currentRoute ||
      currentRoute.targetPort !== lease.rangeStart ||
      currentRoute.hostname !== expectedHostname
    ) {
      ctx.laneProxyService.addRoute(laneId, lease.rangeStart, lane.name);
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
  ): import("../../../shared/types").UpdateOAuthRedirectConfigArgs => {
    const record = requireRecord(value, "OAuth config update");
    const updates: import("../../../shared/types").UpdateOAuthRedirectConfigArgs = {};

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
  ): import("../../../shared/types").GenerateRedirectUrisArgs => {
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
  ): import("../../../shared/types").EncodeOAuthStateArgs => {
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
  ): import("../../../shared/types").DecodeOAuthStateArgs => {
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
        const sessions = ctx.ptyService.enrichSessions(ctx.sessionService.list(arg));
        const laneId = typeof arg?.laneId === "string" ? arg.laneId.trim() : "";
        let chats: AgentChatSessionSummary[] = [];
        try {
          chats = await ctx.agentChatService.listSessions(laneId || undefined);
        } catch {
          chats = [];
        }
        if (chats.length === 0) return sessions;
        const chatStatusBySessionId = new Map(chats.map((chat) => [chat.sessionId, chat.status] as const));
        return sessions.map((session) => {
          if (!isChatToolType(session.toolType)) return session;
          if (session.status !== "running") return session;
          const chatStatus = chatStatusBySessionId.get(session.id);
          if (chatStatus === "active") return { ...session, runtimeState: "running" as const };
          if (chatStatus === "idle") return { ...session, runtimeState: "waiting-input" as const };
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
    const session = ctx.sessionService.get(arg.sessionId);
    if (!session) return null;
    return {
      ...session,
      runtimeState: ctx.ptyService.getRuntimeState(session.id, session.status)
    };
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
    return ctx.agentChatService.listSessions(laneId || undefined);
  });

  ipcMain.handle(IPC.agentChatCreate, async (_event, arg: AgentChatCreateArgs): Promise<AgentChatSession> => {
    const ctx = getCtx();
    return await ctx.agentChatService.createSession(arg);
  });

  ipcMain.handle(IPC.agentChatSend, async (_event, arg: AgentChatSendArgs): Promise<void> => {
    const ctx = getCtx();
    await ctx.agentChatService.sendMessage(arg);
  });

  ipcMain.handle(IPC.agentChatSteer, async (_event, arg: AgentChatSteerArgs): Promise<void> => {
    const ctx = getCtx();
    await ctx.agentChatService.steer(arg);
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

  ipcMain.handle(IPC.agentChatModels, async (_event, arg: AgentChatModelsArgs): Promise<AgentChatModelInfo[]> => {
    const ctx = getCtx();
    return await ctx.agentChatService.getAvailableModels(arg);
  });

  ipcMain.handle(IPC.agentChatDispose, async (_event, arg: AgentChatDisposeArgs): Promise<void> => {
    const ctx = getCtx();
    await ctx.agentChatService.dispose(arg);
  });

  ipcMain.handle(IPC.agentChatUpdateSession, async (_event, arg: AgentChatUpdateSessionArgs): Promise<AgentChatSession> => {
    const ctx = getCtx();
    return await ctx.agentChatService.updateSession(arg);
  });

  ipcMain.handle(IPC.agentChatListContextPacks, async (_event, arg: ContextPackListArgs = {}): Promise<ContextPackOption[]> => {
    const ctx = getCtx();
    return ctx.agentChatService.listContextPacks(arg);
  });

  ipcMain.handle(IPC.agentChatFetchContextPack, async (_event, arg: ContextPackFetchArgs): Promise<ContextPackFetchResult> => {
    const ctx = getCtx();
    return ctx.agentChatService.fetchContextPack(arg);
  });

  ipcMain.handle(IPC.agentChatChangePermissionMode, async (_event, arg: AgentChatChangePermissionModeArgs): Promise<void> => {
    const ctx = getCtx();
    ctx.agentChatService.changePermissionMode(arg);
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
    return ctx.gitService.commit(arg);
  });

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
    return ctx.gitService.push(arg);
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

  ipcMain.handle(IPC.prsCreateFromLane, async (_event, arg: CreatePrFromLaneArgs): Promise<PrSummary> => {
    const ctx = getCtx();
    const created = await ctx.prService.createFromLane(arg);
    triggerAutoContextDocs(ctx, {
      trigger: "per_pr",
      reason: `prs_create_from_lane:${created.id}`
    });
    return created;
  });

  ipcMain.handle(IPC.prsLinkToLane, async (_event, arg: LinkPrToLaneArgs): Promise<PrSummary> => {
    const ctx = getCtx();
    const linked = await ctx.prService.linkToLane(arg);
    triggerAutoContextDocs(ctx, {
      trigger: "per_pr",
      reason: `prs_link_to_lane:${linked.id}`
    });
    return linked;
  });

  ipcMain.handle(IPC.prsGetForLane, async (_event, arg: { laneId: string }): Promise<PrSummary | null> => {
    const ctx = getCtx();
    return ctx.prService.getForLane(arg.laneId);
  });

  ipcMain.handle(IPC.prsListAll, async (): Promise<PrSummary[]> => {
    const ctx = getCtx();
    return ctx.prService.listAll();
  });

  ipcMain.handle(IPC.prsRefresh, async (_event, arg: { prId?: string } = {}): Promise<PrSummary[]> => {
    const ctx = getCtx();
    return await ctx.prService.refresh(arg);
  });

  ipcMain.handle(IPC.prsGetStatus, async (_event, arg: { prId: string }): Promise<PrStatus | null> => {
    const ctx = getCtx();
    try {
      return await ctx.prService.getStatus(arg.prId);
    } catch (err) {
      // Return null for stale/deleted PR IDs instead of crashing
      if (err instanceof Error && err.message.includes("PR not found")) return null;
      throw err;
    }
  });

  ipcMain.handle(IPC.prsGetChecks, async (_event, arg: { prId: string }): Promise<PrCheck[]> => {
    const ctx = getCtx();
    try {
      return await ctx.prService.getChecks(arg.prId);
    } catch (err) {
      if (err instanceof Error && err.message.includes("PR not found")) return [];
      throw err;
    }
  });

  ipcMain.handle(IPC.prsGetComments, async (_event, arg: { prId: string }): Promise<PrComment[]> => {
    const ctx = getCtx();
    try {
      return await ctx.prService.getComments(arg.prId);
    } catch (err) {
      if (err instanceof Error && err.message.includes("PR not found")) return [];
      throw err;
    }
  });

  ipcMain.handle(IPC.prsGetReviews, async (_event, arg: { prId: string }): Promise<PrReview[]> => {
    const ctx = getCtx();
    try {
      return await ctx.prService.getReviews(arg.prId);
    } catch (err) {
      if (err instanceof Error && err.message.includes("PR not found")) return [];
      throw err;
    }
  });

  ipcMain.handle(IPC.prsUpdateDescription, async (_event, arg: UpdatePrDescriptionArgs): Promise<void> => {
    const ctx = getCtx();
    await ctx.prService.updateDescription(arg);
    triggerAutoContextDocs(ctx, {
      trigger: "per_pr",
      reason: `prs_update_description:${arg.prId}`
    });
  });

  ipcMain.handle(IPC.prsDelete, async (_event, arg: DeletePrArgs): Promise<DeletePrResult> => {
    const ctx = getCtx();
    const deleted = await ctx.prService.delete(arg);
    triggerAutoContextDocs(ctx, {
      trigger: "per_pr",
      reason: `prs_delete:${arg.prId}`
    });
    return deleted;
  });

  ipcMain.handle(IPC.prsDraftDescription, async (_event, arg: { laneId: string; model?: string }): Promise<{ title: string; body: string }> => {
    const ctx = getCtx();
    return await ctx.prService.draftDescription(arg.laneId, arg.model);
  });

  ipcMain.handle(IPC.prsLand, async (_event, arg: LandPrArgs): Promise<LandResult> => {
    const ctx = getCtx();
    const landed = await ctx.prService.land(arg);
    triggerAutoContextDocs(ctx, {
      trigger: "per_pr",
      reason: `prs_land:${arg.prId}`
    });
    return landed;
  });

  ipcMain.handle(IPC.prsLandStack, async (_event, arg: LandStackArgs): Promise<LandResult[]> => {
    const ctx = getCtx();
    const landed = await ctx.prService.landStack(arg);
    triggerAutoContextDocs(ctx, {
      trigger: "per_pr",
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
      trigger: "per_pr",
      reason: `prs_create_integration:${arg.integrationLaneName}:${arg.baseBranch}`
    });
    return created;
  });

  ipcMain.handle(IPC.prsLandStackEnhanced, async (_event, arg: LandStackEnhancedArgs): Promise<LandResult[]> => {
    const ctx = getCtx();
    const landed = await ctx.prService.landStackEnhanced(arg);
    triggerAutoContextDocs(ctx, {
      trigger: "per_pr",
      reason: `prs_land_stack_enhanced:${arg.rootLaneId}`
    });
    return landed;
  });

  ipcMain.handle(IPC.prsGetConflictAnalysis, async (_event, arg: { prId: string }) => getCtx().prService.getConflictAnalysis(arg.prId));

  ipcMain.handle(IPC.prsGetMergeContext, async (_event, arg: { prId: string }): Promise<PrMergeContext> => getCtx().prService.getMergeContext(arg.prId));

  ipcMain.handle(IPC.prsListWithConflicts, async () => getCtx().prService.listWithConflicts());

  ipcMain.handle(IPC.prsCreateQueue, async (_event, arg: CreateQueuePrsArgs): Promise<CreateQueuePrsResult> => {
    const ctx = getCtx();
    const created = await ctx.prService.createQueuePrs(arg);
    triggerAutoContextDocs(ctx, {
      trigger: "per_pr",
      reason: `prs_create_queue:${arg.targetBranch ?? "queue"}`
    });
    return created;
  });

  ipcMain.handle(IPC.prsSimulateIntegration, async (_event, arg: SimulateIntegrationArgs): Promise<IntegrationProposal> => getCtx().prService.simulateIntegration(arg));

  ipcMain.handle(IPC.prsCommitIntegration, async (_event, arg: CommitIntegrationArgs): Promise<CreateIntegrationPrResult> => {
    const ctx = getCtx();
    const committed = await ctx.prService.commitIntegration(arg);
    triggerAutoContextDocs(ctx, {
      trigger: "per_pr",
      reason: `prs_commit_integration:${arg.proposalId}:${arg.integrationLaneName}`
    });
    return committed;
  });

  ipcMain.handle(IPC.prsListProposals, async (): Promise<IntegrationProposal[]> =>
    getCtx().prService.listIntegrationProposals(),
  );

  ipcMain.handle(IPC.prsUpdateProposal, async (_event, arg: UpdateIntegrationProposalArgs): Promise<void> =>
    getCtx().prService.updateIntegrationProposal(arg),
  );

  ipcMain.handle(IPC.prsDeleteProposal, async (_event, proposalId: string): Promise<void> =>
    getCtx().prService.deleteIntegrationProposal(proposalId),
  );

  ipcMain.handle(IPC.prsLandQueueNext, async (_event, arg: LandQueueNextArgs): Promise<LandResult> => {
    const ctx = getCtx();
    const landed = await ctx.prService.landQueueNext(arg);
    triggerAutoContextDocs(ctx, {
      trigger: "per_pr",
      reason: `prs_land_queue_next:${arg.groupId}`
    });
    return landed;
  });

  ipcMain.handle(IPC.prsStartQueueAutomation, async (_event, arg) => {
    const ctx = getCtx();
    const state = await ctx.queueLandingService.startQueue(arg);
    triggerAutoContextDocs(ctx, {
      trigger: "per_pr",
      reason: `prs_start_queue_automation:${arg.groupId}`,
    });
    return state;
  });

  ipcMain.handle(IPC.prsPauseQueueAutomation, async (_event, arg) => getCtx().queueLandingService.pauseQueue(arg.queueId));

  ipcMain.handle(IPC.prsResumeQueueAutomation, async (_event, arg) => {
    const ctx = getCtx();
    const state = ctx.queueLandingService.resumeQueue(arg);
    triggerAutoContextDocs(ctx, {
      trigger: "per_pr",
      reason: `prs_resume_queue_automation:${arg.queueId}`,
    });
    return state;
  });

  ipcMain.handle(IPC.prsCancelQueueAutomation, async (_event, arg) => getCtx().queueLandingService.cancelQueue(arg.queueId));

  ipcMain.handle(IPC.prsStartQueueRehearsal, async (_event, arg) => {
    const ctx = getCtx();
    const state = await ctx.queueRehearsalService.startQueueRehearsal(arg);
    triggerAutoContextDocs(ctx, {
      trigger: "per_pr",
      reason: `prs_start_queue_rehearsal:${arg.groupId}`,
    });
    return state;
  });

  ipcMain.handle(IPC.prsCancelQueueRehearsal, async (_event, arg) => getCtx().queueRehearsalService.cancelQueueRehearsal(arg.rehearsalId));

  ipcMain.handle(IPC.prsGetHealth, async (_event, arg: { prId: string }): Promise<PrHealth> => getCtx().prService.getPrHealth(arg.prId));

  ipcMain.handle(IPC.prsGetQueueState, async (_event, arg: { groupId: string }): Promise<QueueLandingState | null> =>
    getCtx().queueLandingService.getQueueStateByGroup(arg.groupId)
  );

  ipcMain.handle(IPC.prsListQueueStates, async (_event, arg = {}) => getCtx().queueLandingService.listQueueStates(arg));

  ipcMain.handle(IPC.prsGetQueueRehearsalState, async (_event, arg: { groupId: string }) =>
    getCtx().queueRehearsalService.getQueueRehearsalStateByGroup(arg.groupId)
  );

  ipcMain.handle(IPC.prsListQueueRehearsals, async (_event, arg = {}) => getCtx().queueRehearsalService.listQueueRehearsals(arg));

  ipcMain.handle(IPC.prsCreateIntegrationLaneForProposal, async (_event, arg: CreateIntegrationLaneForProposalArgs): Promise<CreateIntegrationLaneForProposalResult> =>
    getCtx().prService.createIntegrationLaneForProposal(arg));

  ipcMain.handle(IPC.prsStartIntegrationResolution, async (_event, arg: StartIntegrationResolutionArgs): Promise<StartIntegrationResolutionResult> =>
    getCtx().prService.startIntegrationResolution(arg));

  ipcMain.handle(IPC.prsGetIntegrationResolutionState, async (_event, arg: { proposalId: string }): Promise<IntegrationResolutionState | null> =>
    getCtx().prService.getIntegrationResolutionState(arg.proposalId));

  ipcMain.handle(IPC.prsRecheckIntegrationStep, async (_event, arg: RecheckIntegrationStepArgs): Promise<RecheckIntegrationStepResult> =>
    getCtx().prService.recheckIntegrationStep(arg));

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
    let pty: PtyCreateResult | null = null;
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
      const prep = await ctx.conflictService.prepareResolverSession({
        provider,
        targetLaneId,
        sourceLaneIds,
        cwdLaneId: typeof context.integrationLaneId === "string" && context.integrationLaneId.trim().length > 0
          ? context.integrationLaneId.trim()
          : (typeof context.laneId === "string" && context.laneId.trim().length > 0
            ? context.laneId.trim()
            : undefined),
        scenario: context.scenario ?? (sourceLaneIds.length > 1 ? "integration-merge" : "single-merge")
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

      pty = await ctx.ptyService.create({
        laneId: prep.cwdLaneId,
        cwd: prep.cwdWorktreePath,
        cols: 100,
        rows: 30,
        title: `PR AI resolution (${provider})`,
        tracked: false,
        toolType: provider
      });

      const command = buildPrAiResolverCommand(provider, {
        promptFilePath: prep.promptFilePath,
        permissionMode,
        model,
        reasoning
      });
      ctx.ptyService.write({ ptyId: pty.ptyId, data: `${command}\r` });

      const runtime: PrAiRuntimeSession = {
        sessionId: pty.sessionId,
        ptyId: pty.ptyId,
        runId: prep.runId,
        provider,
        context,
        pollTimer: null,
        finalizing: false
      };
      runtime.pollTimer = setInterval(() => {
        const current = prAiSessions.get(runtime.sessionId);
        if (!current || current.finalizing) return;
        const detail = getCtx().sessionService.get(runtime.sessionId);
        if (!detail || detail.status === "running") return;
        void finalizePrAiSession(runtime.sessionId);
      }, 1_000);
      prAiSessions.set(runtime.sessionId, runtime);
      emitPrAiResolutionEvent({
        sessionId: runtime.sessionId,
        status: "running",
        message: null,
        timestamp: nowIso()
      });
      return {
        sessionId: runtime.sessionId,
        provider,
        ptyId: runtime.ptyId,
        status: "started",
        error: null,
        context
      };
    } catch (error) {
      if (pty?.ptyId) {
        try {
          ctx.ptyService.dispose({ ptyId: pty.ptyId, sessionId: pty.sessionId });
        } catch {
          // ignore dispose failures
        }
      }
      if (runId) {
        try {
          await ctx.conflictService.finalizeResolverSession({ runId, exitCode: 1 });
        } catch {
          // ignore finalize failures
        }
      }
      const sessionId = pty?.sessionId ?? randomUUID();
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
        ptyId: pty?.ptyId ?? null,
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
    ctx.ptyService.write({ ptyId: runtime.ptyId, data: text });
  });

  ipcMain.handle(IPC.prsAiResolutionStop, async (_event, arg: PrAiResolutionStopArgs): Promise<void> => {
    const sessionId = typeof arg?.sessionId === "string" ? arg.sessionId.trim() : "";
    if (!sessionId) return;
    const runtime = prAiSessions.get(sessionId);
    if (!runtime) return;
    const ctx = getCtx();
    ctx.ptyService.dispose({ ptyId: runtime.ptyId, sessionId });
    await finalizePrAiSession(sessionId, {
      forceStatus: "cancelled",
      message: "AI resolution stopped by user."
    });
  });

  ipcMain.handle(IPC.prsGetDetail, (_e, args: { prId: string }) => getCtx().prService.getDetail(args.prId));
  ipcMain.handle(IPC.prsGetFiles, (_e, args: { prId: string }) => getCtx().prService.getFiles(args.prId));
  ipcMain.handle(IPC.prsGetActionRuns, (_e, args: { prId: string }) => getCtx().prService.getActionRuns(args.prId));
  ipcMain.handle(IPC.prsGetActivity, (_e, args: { prId: string }) => getCtx().prService.getActivity(args.prId));
  ipcMain.handle(IPC.prsAddComment, (_e, args) => getCtx().prService.addComment(args));
  ipcMain.handle(IPC.prsUpdateTitle, (_e, args) => getCtx().prService.updateTitle(args));
  ipcMain.handle(IPC.prsUpdateBody, (_e, args) => getCtx().prService.updateBody(args));
  ipcMain.handle(IPC.prsSetLabels, (_e, args) => getCtx().prService.setLabels(args));
  ipcMain.handle(IPC.prsRequestReviewers, (_e, args) => getCtx().prService.requestReviewers(args));
  ipcMain.handle(IPC.prsSubmitReview, (_e, args) => getCtx().prService.submitReview(args));
  ipcMain.handle(IPC.prsClose, (_e, args) => getCtx().prService.closePr(args));
  ipcMain.handle(IPC.prsReopen, (_e, args) => getCtx().prService.reopenPr(args));
  ipcMain.handle(IPC.prsRerunChecks, (_e, args) => getCtx().prService.rerunChecks(args));
  ipcMain.handle(IPC.prsAiReviewSummary, (_e, args) => getCtx().prService.aiReviewSummary(args));

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

  ipcMain.handle(IPC.processesStop, async (_event, arg: ProcessActionArgs): Promise<ProcessRuntime> => {
    const ctx = getCtx();
    return await ctx.processService.stop(arg);
  });

  ipcMain.handle(IPC.processesRestart, async (_event, arg: ProcessActionArgs): Promise<ProcessRuntime> => {
    const ctx = getCtx();
    return await ctx.processService.restart(arg);
  });

  ipcMain.handle(IPC.processesKill, async (_event, arg: ProcessActionArgs): Promise<ProcessRuntime> => {
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
        category: "fact" | "preference" | "pattern" | "decision" | "gotcha";
        content: string;
        importance?: "low" | "medium" | "high";
        sourceRunId?: string;
      }
    ) => {
      const ctx = getCtx();
      if (!ctx.memoryService) return null;
      const pid = arg?.projectId ?? ctx.projectId;
      const scope = normalizeMemoryScope(typeof arg?.scope === "string" ? arg.scope : "") ?? "project";
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
    void ctx.embeddingService.preload({ forceRetry: true }).catch(() => {
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
      permissionMode: arg.permissionMode,
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
      permissionMode: arg.permissionMode,
    });
  });

  ipcMain.handle(IPC.ctoGetBudgetSnapshot, async (_event, arg: CtoGetBudgetSnapshotArgs = {}): Promise<AgentBudgetSnapshot> => {
    const ctx = getCtx();
    if (!ctx.workerBudgetService) throw new Error("Worker budget service is not available.");
    return ctx.workerBudgetService.getBudgetSnapshot({ monthKey: arg.monthKey });
  });

  ipcMain.handle(IPC.ctoUpdateIdentity, async (_event, arg: { patch: Record<string, unknown> }): Promise<CtoSnapshot> => {
    const ctx = getCtx();
    if (!ctx.ctoStateService) throw new Error("CTO state service is not available.");
    // updateIdentity not yet implemented on ctoStateService — return current snapshot
    return ctx.ctoStateService.getSnapshot(20);
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
      message: "Linear token cleared.",
    };
  });

  ipcMain.handle(IPC.ctoGetFlowPolicy, async (): Promise<LinearSyncConfig> => {
    const ctx = getCtx();
    if (!ctx.flowPolicyService) throw new Error("Flow policy service is not available.");
    return ctx.flowPolicyService.getPolicy();
  });

  ipcMain.handle(IPC.ctoSaveFlowPolicy, async (_event, arg: CtoSaveFlowPolicyArgs): Promise<LinearSyncConfig> => {
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

  ipcMain.handle(IPC.ctoRollbackFlowPolicyRevision, async (_event, arg: CtoRollbackFlowPolicyRevisionArgs): Promise<LinearSyncConfig> => {
    const ctx = getCtx();
    if (!ctx.flowPolicyService) throw new Error("Flow policy service is not available.");
    return ctx.flowPolicyService.rollbackRevision(arg.revisionId, arg.actor ?? "user");
  });

  ipcMain.handle(IPC.ctoSimulateFlowRoute, async (_event, arg: CtoSimulateFlowRouteArgs): Promise<LinearRouteDecision> => {
    const ctx = getCtx();
    if (!ctx.linearRoutingService) throw new Error("Linear routing service is not available.");

    const now = nowIso();
    const issue: NormalizedLinearIssue = {
      id: arg.issue.id ?? `sim-${randomUUID()}`,
      identifier: arg.issue.identifier ?? "SIM-1",
      title: arg.issue.title,
      description: arg.issue.description ?? "",
      url: arg.issue.url ?? null,
      projectId: arg.issue.projectId ?? "sim-project",
      projectSlug: arg.issue.projectSlug ?? (ctx.flowPolicyService?.getPolicy().projects?.[0]?.slug ?? "sim-project"),
      teamId: arg.issue.teamId ?? "sim-team",
      teamKey: arg.issue.teamKey ?? "SIM",
      stateId: arg.issue.stateId ?? "sim-state",
      stateName: arg.issue.stateName ?? "Todo",
      stateType: arg.issue.stateType ?? "unstarted",
      priority: Number.isFinite(Number(arg.issue.priority)) ? Number(arg.issue.priority) : 3,
      priorityLabel: arg.issue.priorityLabel ?? "normal",
      labels: Array.isArray(arg.issue.labels) ? arg.issue.labels : [],
      assigneeId: arg.issue.assigneeId ?? null,
      assigneeName: arg.issue.assigneeName ?? null,
      ownerId: arg.issue.ownerId ?? null,
      blockerIssueIds: Array.isArray(arg.issue.blockerIssueIds) ? arg.issue.blockerIssueIds : [],
      hasOpenBlockers: Boolean(arg.issue.hasOpenBlockers),
      createdAt: arg.issue.createdAt ?? now,
      updatedAt: arg.issue.updatedAt ?? now,
      raw: isRecord(arg.issue.raw) ? arg.issue.raw : {},
    };
    return ctx.linearRoutingService.simulateRoute({ issue });
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
}
