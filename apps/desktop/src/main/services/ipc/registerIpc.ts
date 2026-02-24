import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { IPC } from "../../../shared/ipc";
import type {
  ApplyConflictProposalArgs,
  BatchAssessmentResult,
  AttachLaneArgs,
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
  CreateStackedPrsArgs,
  CreateStackedPrsResult,
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
  LinkPrToLaneArgs,
  LandResult,
  LandStackEnhancedArgs,
  LandQueueNextArgs,
  PrCheck,
  PrComment,
  PrConflictAnalysis,
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
  ExportConfigBundleResult,
  AgentChatApproveArgs,
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
  PackType,
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
  ContextPrepareDocGenArgs,
  ContextPrepareDocGenResult,
  ContextInstallGeneratedDocsArgs,
  ContextOpenDocArgs,
  ContextInventorySnapshot,
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
  RestackArgs,
  RestackResult,
  RestackSuggestion,
  AutoRebaseLaneStatus,
  RiskMatrixEntry,
  PrepareConflictProposalArgs,
  RequestConflictProposalArgs,
  RunExternalConflictResolverArgs,
  ListExternalConflictResolverRunsArgs,
  CommitExternalConflictResolverRunArgs,
  CommitExternalConflictResolverRunResult,
  RunConflictPredictionArgs,
  UndoConflictProposalArgs,
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
  MissionStepHandoff,
  MissionSummary,
  MissionExecutorPolicy,
  MissionPlannerAttempt,
  MissionPlannerRun,
  ResolveMissionInterventionArgs,
  CreateMissionArgs,
  PlanMissionArgs,
  PlanMissionResult,
  ListPlannerRunsArgs,
  GetPlannerAttemptArgs,
  DeleteMissionArgs,
  CancelOrchestratorRunArgs,
  CompleteOrchestratorAttemptArgs,
  GetOrchestratorGateReportArgs,
  GetOrchestratorRunGraphArgs,
  HeartbeatOrchestratorClaimsArgs,
  ListOrchestratorRunsArgs,
  ListOrchestratorTimelineArgs,
  OrchestratorAttempt,
  OrchestratorClaim,
  OrchestratorContextSnapshot,
  OrchestratorExecutorKind,
  OrchestratorGateReport,
  OrchestratorRun,
  OrchestratorRunGraph,
  OrchestratorStep,
  OrchestratorTimelineEvent,
  ResumeOrchestratorRunArgs,
  StartOrchestratorAttemptArgs,
  StartOrchestratorRunFromMissionArgs,
  StartOrchestratorRunArgs,
  TickOrchestratorRunArgs,
  AiFeatureKey,
  AiSettingsStatus,
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
  MissionMetricsConfig,
  MissionMetricSample,
  SetMissionMetricsConfigArgs,
  ExecutionPlanPreview,
  SendAgentMessageArgs
} from "../../../shared/types";
import type { Logger } from "../logging/logger";
import type { AdeDb } from "../state/kvDb";
import type { createLaneService } from "../lanes/laneService";
import type { createRestackSuggestionService } from "../lanes/restackSuggestionService";
import type { createAutoRebaseService } from "../lanes/autoRebaseService";
import type { createSessionService } from "../sessions/sessionService";
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
import type { createAgentChatService } from "../chat/agentChatService";
import { readGlobalState, writeGlobalState } from "../state/globalState";
import type { createKeybindingsService } from "../keybindings/keybindingsService";
import type { createTerminalProfilesService } from "../terminalProfiles/terminalProfilesService";
import type { createAgentToolsService } from "../agentTools/agentToolsService";
import type { createOnboardingService } from "../onboarding/onboardingService";
import type { createCiService } from "../ci/ciService";
import type { createAutomationService } from "../automations/automationService";
import type { createAutomationPlannerService } from "../automations/automationPlannerService";
import type { createMissionService } from "../missions/missionService";
import { planMissionOnce, plannerPlanToMissionSteps } from "../missions/missionPlanningService";
import type { createOrchestratorService } from "../orchestrator/orchestratorService";
import type { createAiOrchestratorService } from "../orchestrator/aiOrchestratorService";
import { redactSecrets } from "../../utils/redaction";

export type AppContext = {
  db: AdeDb;
  logger: Logger;
  project: ProjectInfo;
  projectId: string;
  adeDir: string;
  disposeHeadWatcher: () => void;
  keybindingsService: ReturnType<typeof createKeybindingsService>;
  terminalProfilesService: ReturnType<typeof createTerminalProfilesService>;
  agentToolsService: ReturnType<typeof createAgentToolsService>;
  onboardingService: ReturnType<typeof createOnboardingService>;
  ciService: ReturnType<typeof createCiService>;
  laneService: ReturnType<typeof createLaneService>;
  restackSuggestionService: ReturnType<typeof createRestackSuggestionService> | null;
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
  jobEngine: ReturnType<typeof createJobEngine>;
  automationService: ReturnType<typeof createAutomationService>;
  automationPlannerService: ReturnType<typeof createAutomationPlannerService>;
  missionService: ReturnType<typeof createMissionService>;
  orchestratorService: ReturnType<typeof createOrchestratorService>;
  aiOrchestratorService: ReturnType<typeof createAiOrchestratorService>;
  packService: ReturnType<typeof createPackService>;
  projectConfigService: ReturnType<typeof createProjectConfigService>;
  processService: ReturnType<typeof createProcessService>;
  testService: ReturnType<typeof createTestService>;
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

function parseRecord(raw: string | null | undefined): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

const AI_USAGE_FEATURE_KEYS: AiFeatureKey[] = [
  "narratives",
  "conflict_proposals",
  "pr_descriptions",
  "terminal_summaries",
  "mission_planning",
  "orchestrator",
  "initial_context"
];

function normalizePackType(value: string): PackType {
  if (value === "project" || value === "lane" || value === "feature" || value === "conflict" || value === "plan" || value === "mission") {
    return value;
  }
  return "project";
}

function normalizeMissionStatus(value: string): MissionStatus {
  if (
    value === "queued" ||
    value === "planning" ||
    value === "plan_review" ||
    value === "in_progress" ||
    value === "intervention_required" ||
    value === "completed" ||
    value === "failed" ||
    value === "canceled"
  ) {
    return value;
  }
  return "queued";
}

function sha256Utf8(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function buildMissionPlannerDocsDigest(projectRoot: string): Array<{ path: string; sha256: string; bytes: number }> {
  const roots = [path.join(projectRoot, "docs", "PRD.md"), path.join(projectRoot, "docs", "architecture")];
  const docs: Array<{ path: string; sha256: string; bytes: number }> = [];

  const visit = (candidatePath: string) => {
    if (!fs.existsSync(candidatePath)) return;
    const stat = fs.statSync(candidatePath);
    if (stat.isDirectory()) {
      const entries = fs.readdirSync(candidatePath, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name.startsWith(".")) continue;
        visit(path.join(candidatePath, entry.name));
      }
      return;
    }
    if (!stat.isFile()) return;
    if (!candidatePath.toLowerCase().endsWith(".md")) return;
    const content = fs.readFileSync(candidatePath, "utf8");
    docs.push({
      path: path.relative(projectRoot, candidatePath).replace(/\\/g, "/"),
      sha256: sha256Utf8(content),
      bytes: Buffer.byteLength(content, "utf8")
    });
  };

  for (const root of roots) {
    visit(root);
  }
  docs.sort((a, b) => a.path.localeCompare(b.path));
  return docs.slice(0, 60);
}

function normalizeAutopilotExecutor(value: unknown): OrchestratorExecutorKind {
  const raw = typeof value === "string" ? value.trim() : "";
  if (raw === "claude" || raw === "codex" || raw === "shell" || raw === "manual") return raw;
  return "codex";
}

function normalizeMissionExecutorPolicy(value: unknown): MissionExecutorPolicy {
  const raw = typeof value === "string" ? value.trim() : "";
  if (raw === "claude" || raw === "codex" || raw === "both") return raw;
  return "both";
}

function defaultExecutorForPolicy(policy: MissionExecutorPolicy): OrchestratorExecutorKind {
  if (policy === "claude") return "claude";
  return "codex";
}

function buildMissionPlanningContextBundle(args: {
  ctx: AppContext;
  laneId: string | null;
  executionMode: string;
  targetMachineId: string | null;
}) {
  const operationRows = args.ctx.db.all<{ kind: string; status: string; ended_at: string | null }>(
    `
      select kind, status, ended_at
      from operations
      where project_id = ?
      order by coalesce(ended_at, started_at) desc
      limit 24
    `,
    [args.ctx.projectId]
  );
  return {
    missionProfile: {
      projectId: args.ctx.projectId,
      projectRoot: args.ctx.project.rootPath,
      laneId: args.laneId,
      executionMode: args.executionMode,
      targetMachineId: args.targetMachineId
    },
    operationSummary: {
      total: operationRows.length,
      recent: operationRows
    },
    docsDigest: buildMissionPlannerDocsDigest(args.ctx.project.rootPath),
    constraints: [
      "no user interaction unless blocked",
      "no arbitrary shell",
      "prefer minimal parallelism unless independent",
      "runtime must be deterministic from validated plan artifact"
    ]
  };
}

function buildContextInventorySnapshot(ctx: AppContext): ContextInventorySnapshot {
  const generatedAt = new Date().toISOString();

  const packCountsRows = ctx.db.all<{ pack_type: string; count: number }>(
    `
      select pack_type, count(*) as count
      from packs_index
      where project_id = ?
      group by pack_type
    `,
    [ctx.projectId]
  );
  const packByType: Partial<Record<PackType, number>> = {};
  for (const row of packCountsRows) {
    packByType[normalizePackType(row.pack_type)] = Number(row.count ?? 0);
  }

  const recentPacks = ctx.db
    .all<{
      pack_key: string;
      pack_type: string;
      lane_id: string | null;
      deterministic_updated_at: string | null;
      narrative_updated_at: string | null;
      last_head_sha: string | null;
      metadata_json: string | null;
      version_id: string | null;
      version_number: number | null;
      content_hash: string | null;
    }>(
      `
        select
          p.pack_key,
          p.pack_type,
          p.lane_id,
          p.deterministic_updated_at,
          p.narrative_updated_at,
          p.last_head_sha,
          p.metadata_json,
          pv.id as version_id,
          pv.version_number as version_number,
          pv.content_hash as content_hash
        from packs_index p
        left join pack_heads ph
          on ph.project_id = p.project_id
         and ph.pack_key = p.pack_key
        left join pack_versions pv
          on pv.id = ph.current_version_id
        where p.project_id = ?
        order by coalesce(p.deterministic_updated_at, p.narrative_updated_at, '') desc
        limit 30
      `,
      [ctx.projectId]
    )
    .map((row) => {
      const metadata = parseRecord(row.metadata_json);
      return {
        packKey: row.pack_key,
        packType: normalizePackType(row.pack_type),
        laneId: row.lane_id,
        deterministicUpdatedAt: row.deterministic_updated_at,
        narrativeUpdatedAt: row.narrative_updated_at,
        lastHeadSha: row.last_head_sha,
        versionId: row.version_id ?? (typeof metadata?.versionId === "string" ? metadata.versionId : null),
        versionNumber:
          row.version_number != null
            ? Number(row.version_number)
            : Number.isFinite(Number(metadata?.versionNumber))
              ? Number(metadata?.versionNumber)
              : null,
        contentHash: row.content_hash ?? (typeof metadata?.contentHash === "string" ? metadata.contentHash : null)
      };
    });

  const checkpointsTotal = Number(
    ctx.db.get<{ count: number }>("select count(*) as count from checkpoints where project_id = ?", [ctx.projectId])?.count ?? 0
  );
  const recentCheckpoints = ctx.db
    .all<{
      id: string;
      lane_id: string;
      session_id: string | null;
      created_at: string;
      sha: string;
    }>(
      `
        select id, lane_id, session_id, created_at, sha
        from checkpoints
        where project_id = ?
        order by created_at desc
        limit 25
      `,
      [ctx.projectId]
    )
    .map((row) => ({
      id: row.id,
      laneId: row.lane_id,
      sessionId: row.session_id,
      createdAt: row.created_at,
      sha: row.sha
    }));

  const sessionCounts = ctx.db.get<{
    tracked_sessions: number;
    untracked_sessions: number;
    running_sessions: number;
  }>(
    `
      select
        sum(case when s.tracked = 1 then 1 else 0 end) as tracked_sessions,
        sum(case when s.tracked = 0 then 1 else 0 end) as untracked_sessions,
        sum(case when s.status = 'running' then 1 else 0 end) as running_sessions
      from terminal_sessions s
      join lanes l on l.id = s.lane_id
      where l.project_id = ?
    `,
    [ctx.projectId]
  );

  const recentDeltas = ctx.db
    .all<{
      session_id: string;
      lane_id: string;
      started_at: string;
      ended_at: string | null;
      files_changed: number;
      insertions: number;
      deletions: number;
      computed_at: string | null;
    }>(
      `
        select
          session_id,
          lane_id,
          started_at,
          ended_at,
          files_changed,
          insertions,
          deletions,
          computed_at
        from session_deltas
        where project_id = ?
        order by computed_at desc
        limit 25
      `,
      [ctx.projectId]
    )
    .map((row) => ({
      sessionId: row.session_id,
      laneId: row.lane_id,
      startedAt: row.started_at,
      endedAt: row.ended_at,
      filesChanged: Number(row.files_changed ?? 0),
      insertions: Number(row.insertions ?? 0),
      deletions: Number(row.deletions ?? 0),
      computedAt: row.computed_at
    }));

  const missionTotal = Number(
    ctx.db.get<{ count: number }>("select count(*) as count from missions where project_id = ?", [ctx.projectId])?.count ?? 0
  );
  const missionStatusRows = ctx.db.all<{ status: string; count: number }>(
    `
      select status, count(*) as count
      from missions
      where project_id = ?
      group by status
    `,
    [ctx.projectId]
  );
  const missionsByStatus: Partial<Record<MissionStatus, number>> = {};
  for (const row of missionStatusRows) {
    missionsByStatus[normalizeMissionStatus(row.status)] = Number(row.count ?? 0);
  }
  const openInterventions = Number(
    ctx.db.get<{ count: number }>(
      "select count(*) as count from mission_interventions where project_id = ? and status = 'open'",
      [ctx.projectId]
    )?.count ?? 0
  );
  const recentMissionHandoffs = ctx.db
    .all<{
      id: string;
      mission_id: string;
      mission_step_id: string | null;
      run_id: string | null;
      step_id: string | null;
      attempt_id: string | null;
      handoff_type: string;
      producer: string;
      payload_json: string;
      created_at: string;
    }>(
      `
        select
          id,
          mission_id,
          mission_step_id,
          run_id,
          step_id,
          attempt_id,
          handoff_type,
          producer,
          payload_json,
          created_at
        from mission_step_handoffs
        where project_id = ?
        order by created_at desc
        limit 20
      `,
      [ctx.projectId]
    )
    .map(
      (row): MissionStepHandoff => ({
        id: row.id,
        missionId: row.mission_id,
        missionStepId: row.mission_step_id,
        runId: row.run_id,
        stepId: row.step_id,
        attemptId: row.attempt_id,
        handoffType: row.handoff_type,
        producer: row.producer,
        payload: parseRecord(row.payload_json) ?? {},
        createdAt: row.created_at
      })
    );

  const orchestratorCounts = ctx.db.get<{
    active_runs: number;
    running_steps: number;
    running_attempts: number;
    active_claims: number;
    expired_claims: number;
    snapshots: number;
    handoffs: number;
    timeline_events: number;
  }>(
    `
      select
        (select count(*) from orchestrator_runs where project_id = ? and status in ('queued', 'running', 'paused')) as active_runs,
        (select count(*) from orchestrator_steps where project_id = ? and status = 'running') as running_steps,
        (select count(*) from orchestrator_attempts where project_id = ? and status = 'running') as running_attempts,
        (select count(*) from orchestrator_claims where project_id = ? and state = 'active') as active_claims,
        (select count(*) from orchestrator_claims where project_id = ? and state = 'expired') as expired_claims,
        (select count(*) from orchestrator_context_snapshots where project_id = ?) as snapshots,
        (select count(*) from mission_step_handoffs where project_id = ? and run_id is not null) as handoffs,
        (select count(*) from orchestrator_timeline_events where project_id = ?) as timeline_events
    `,
    [ctx.projectId, ctx.projectId, ctx.projectId, ctx.projectId, ctx.projectId, ctx.projectId, ctx.projectId, ctx.projectId]
  );
  const recentRunIds = ctx.db
    .all<{ id: string }>(
      `
        select id
        from orchestrator_runs
        where project_id = ?
        order by updated_at desc, created_at desc
        limit 12
      `,
      [ctx.projectId]
    )
    .map((row) => row.id);
  const recentAttemptIds = ctx.db
    .all<{ id: string }>(
      `
        select id
        from orchestrator_attempts
        where project_id = ?
        order by created_at desc
        limit 20
      `,
      [ctx.projectId]
    )
    .map((row) => row.id);

  return {
    generatedAt,
    packs: {
      total: Object.values(packByType).reduce((sum, value) => sum + Number(value ?? 0), 0),
      byType: packByType,
      recent: recentPacks
    },
    checkpoints: {
      total: checkpointsTotal,
      recent: recentCheckpoints
    },
    sessionTracking: {
      trackedSessions: Number(sessionCounts?.tracked_sessions ?? 0),
      untrackedSessions: Number(sessionCounts?.untracked_sessions ?? 0),
      runningSessions: Number(sessionCounts?.running_sessions ?? 0),
      recentDeltas
    },
    missions: {
      total: missionTotal,
      byStatus: missionsByStatus,
      openInterventions,
      recentHandoffs: recentMissionHandoffs
    },
    orchestrator: {
      activeRuns: Number(orchestratorCounts?.active_runs ?? 0),
      runningSteps: Number(orchestratorCounts?.running_steps ?? 0),
      runningAttempts: Number(orchestratorCounts?.running_attempts ?? 0),
      activeClaims: Number(orchestratorCounts?.active_claims ?? 0),
      expiredClaims: Number(orchestratorCounts?.expired_claims ?? 0),
      snapshots: Number(orchestratorCounts?.snapshots ?? 0),
      handoffs: Number(orchestratorCounts?.handoffs ?? 0),
      timelineEvents: Number(orchestratorCounts?.timeline_events ?? 0),
      recentRunIds,
      recentAttemptIds
    }
  };
}

export function registerIpc({
  getCtx,
  switchProjectFromDialog,
  globalStatePath
}: {
  getCtx: () => AppContext;
  switchProjectFromDialog: (selectedPath: string) => Promise<ProjectInfo>;
  globalStatePath: string;
}) {
  const watcherCleanupBoundSenders = new Set<number>();

  ipcMain.handle(IPC.appPing, async () => "pong" as const);

  ipcMain.handle(IPC.appGetProject, async () => getCtx().project);

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

  ipcMain.handle(IPC.projectOpenRepo, async (event): Promise<ProjectInfo> => {
    const win = BrowserWindow.fromWebContents(event.sender) ?? undefined;
    const options: Electron.OpenDialogOptions = {
      title: "Open repository",
      properties: ["openDirectory"]
    };
    const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
    if (result.canceled || result.filePaths.length === 0) {
      return getCtx().project;
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
    const clearedAt = new Date().toISOString();
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

  ipcMain.handle(IPC.projectExportConfig, async (event): Promise<ExportConfigBundleResult> => {
    const ctx = getCtx();
    const win = BrowserWindow.fromWebContents(event.sender) ?? undefined;

    const snapshot = ctx.projectConfigService.get();
    const sharedPath = snapshot.paths.sharedPath;
    const localPath = snapshot.paths.localPath;

    const readText = (p: string): string => {
      try {
        return fs.readFileSync(p, "utf8");
      } catch {
        return "";
      }
    };

    const redactSecrets = (input: string): string => {
      let output = input;
      output = output.replace(
        /((?:api[_-]?key|token|secret|password|refreshToken|accessToken|idToken)\s*:\s*)(["']?)[^\s"']{6,}\2/gi,
        "$1<redacted>"
      );
      output = output.replace(
        /-----BEGIN [^-]+ PRIVATE KEY-----[\s\S]*?-----END [^-]+ PRIVATE KEY-----/g,
        "<redacted-private-key>"
      );
      output = output.replace(
        /\b(?:ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,})\b/g,
        "<redacted-token>"
      );
      return output;
    };

    const defaultName = `ade-config-${ctx.project.displayName.replace(/[^a-zA-Z0-9._-]+/g, "_")}-${new Date()
      .toISOString()
      .slice(0, 10)}.json`;
    const defaultPath = path.join(ctx.project.rootPath, defaultName);

    const result = win
      ? await dialog.showSaveDialog(win, {
          title: "Export ADE config",
          defaultPath,
          buttonLabel: "Export",
          filters: [{ name: "JSON", extensions: ["json"] }]
        })
      : await dialog.showSaveDialog({
          title: "Export ADE config",
          defaultPath,
          buttonLabel: "Export",
          filters: [{ name: "JSON", extensions: ["json"] }]
        });

    if (result.canceled || !result.filePath) {
      return { cancelled: true };
    }

    const exportedAt = new Date().toISOString();
    const bundle = {
      exportedAt,
      project: ctx.project,
      config: {
        sharedPath,
        localPath,
        sharedYaml: readText(sharedPath),
        localYamlRedacted: redactSecrets(readText(localPath))
      }
    };

    const content = `${JSON.stringify(bundle, null, 2)}\n`;
    fs.writeFileSync(result.filePath, content, "utf8");

    return {
      cancelled: false,
      savedPath: result.filePath,
      bytesWritten: Buffer.byteLength(content, "utf8"),
      exportedAt
    };
  });

  ipcMain.handle(IPC.projectListRecent, async (): Promise<RecentProjectSummary[]> => {
    const state = readGlobalState(globalStatePath);
    return (state.recentProjects ?? []).map((entry) => ({
      rootPath: entry.rootPath,
      displayName: entry.displayName,
      lastOpenedAt: entry.lastOpenedAt,
      exists: fs.existsSync(entry.rootPath)
    }));
  });

  ipcMain.handle(IPC.projectForgetRecent, async (_event, arg: { rootPath: string }): Promise<RecentProjectSummary[]> => {
    const rootPath = typeof arg?.rootPath === "string" ? arg.rootPath.trim() : "";
    if (!rootPath) {
      const state = readGlobalState(globalStatePath);
      return (state.recentProjects ?? []).map((entry) => ({
        rootPath: entry.rootPath,
        displayName: entry.displayName,
        lastOpenedAt: entry.lastOpenedAt,
        exists: fs.existsSync(entry.rootPath)
      }));
    }
    const state = readGlobalState(globalStatePath);
    const filtered = (state.recentProjects ?? []).filter((entry) => entry.rootPath !== rootPath);
    const next = { ...state, recentProjects: filtered };
    if (next.lastProjectRoot === rootPath) {
      delete next.lastProjectRoot;
    }
    writeGlobalState(globalStatePath, next);
    return filtered.map((entry) => ({
      rootPath: entry.rootPath,
      displayName: entry.displayName,
      lastOpenedAt: entry.lastOpenedAt,
      exists: fs.existsSync(entry.rootPath)
    }));
  });

  ipcMain.handle(IPC.projectSwitchToPath, async (_event, arg: { rootPath: string }): Promise<ProjectInfo> => {
    const rootPath = typeof arg?.rootPath === "string" ? arg.rootPath.trim() : "";
    if (!rootPath) return getCtx().project;
    if (rootPath === getCtx().project.rootPath) return getCtx().project;
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
    return {
      mode: status.mode,
      availableProviders: status.availableProviders,
      models: status.models,
      features: AI_USAGE_FEATURE_KEYS.map((feature) => ({
        feature,
        enabled: ctx.aiIntegrationService.getFeatureFlag(feature),
        dailyUsage: ctx.aiIntegrationService.getDailyUsage(feature),
        dailyLimit: ctx.aiIntegrationService.getDailyBudgetLimit(feature)
      }))
    };
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
    return ctx.onboardingService.getStatus();
  });

  ipcMain.handle(IPC.onboardingDetectDefaults, async (): Promise<OnboardingDetectionResult> => {
    const ctx = getCtx();
    return await ctx.onboardingService.detectDefaults();
  });

  ipcMain.handle(IPC.onboardingDetectExistingLanes, async (): Promise<OnboardingExistingLaneCandidate[]> => {
    const ctx = getCtx();
    return await ctx.onboardingService.detectExistingLanes();
  });

  ipcMain.handle(IPC.onboardingGenerateInitialPacks, async (_event, arg: { laneIds?: string[] } = {}): Promise<void> => {
    const ctx = getCtx();
    await ctx.onboardingService.generateInitialPacks({ laneIds: arg.laneIds });
  });

  ipcMain.handle(IPC.onboardingComplete, async (): Promise<OnboardingStatus> => {
    const ctx = getCtx();
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

  ipcMain.handle(IPC.plannerPlanMission, async (_event, arg: PlanMissionArgs): Promise<PlanMissionResult> => {
    const ctx = getCtx();
    const prompt = typeof arg?.prompt === "string" ? arg.prompt.trim() : "";
    if (!prompt.length) throw new Error("Mission prompt is required.");
    const title =
      typeof arg?.title === "string" && arg.title.trim().length > 0
        ? arg.title.trim()
        : prompt.split(/\r?\n/).map((line) => line.trim()).find((line) => line.length > 0) ?? "Mission";
    const plannerEngine = arg?.plannerEngine ?? "auto";
    const laneId = typeof arg?.laneId === "string" && arg.laneId.trim().length > 0 ? arg.laneId.trim() : null;
    const executorPolicy = normalizeMissionExecutorPolicy(arg?.executorPolicy);
    const planning = await planMissionOnce({
      missionId: typeof arg?.missionId === "string" ? arg.missionId.trim() : undefined,
      title,
      prompt,
      laneId,
      plannerEngine,
      timeoutMs: arg?.planningTimeoutMs,
      allowPlanningQuestions: arg?.allowPlanningQuestions,
      projectRoot: ctx.project.rootPath,
      contextBundle: buildMissionPlanningContextBundle({
        ctx,
        laneId,
        executionMode: "local",
        targetMachineId: null
      }),
      aiIntegrationService: ctx.aiIntegrationService,
      logger: ctx.logger
    });
    const plannedSteps = plannerPlanToMissionSteps({
      plan: planning.plan,
      requestedEngine: planning.run.requestedEngine,
      resolvedEngine: planning.run.resolvedEngine!,
      executorPolicy,
      degraded: planning.run.degraded,
      reasonCode: planning.run.reasonCode,
      validationErrors: planning.run.validationErrors
    });
    return {
      plan: planning.plan,
      run: planning.run,
      plannedSteps
    };
  });

  ipcMain.handle(IPC.plannerGetRuns, async (_event, arg: ListPlannerRunsArgs = {}): Promise<MissionPlannerRun[]> => {
    const ctx = getCtx();
    return ctx.missionService.listPlannerRuns(arg);
  });

  ipcMain.handle(IPC.plannerGetAttempt, async (_event, arg: GetPlannerAttemptArgs): Promise<MissionPlannerAttempt | null> => {
    const ctx = getCtx();
    return ctx.missionService.getPlannerAttempt(arg);
  });

  ipcMain.handle(IPC.missionsList, async (_event, arg: ListMissionsArgs = {}): Promise<MissionSummary[]> => {
    const ctx = getCtx();
    return ctx.missionService.list(arg);
  });

  ipcMain.handle(IPC.missionsGet, async (_event, arg: { missionId: string }): Promise<MissionDetail | null> => {
    const ctx = getCtx();
    return ctx.missionService.get(arg?.missionId ?? "");
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
    const executorPolicy = normalizeMissionExecutorPolicy(arg?.executorPolicy);
    const executionMode = arg?.executionMode ?? "local";
    const targetMachineId = typeof arg?.targetMachineId === "string" ? arg.targetMachineId.trim() || null : null;
    const autostart = arg?.autostart !== false;
    const runMode = arg?.launchMode === "manual" ? "manual" : "autopilot";
    const defaultExecutorKind: OrchestratorExecutorKind = runMode === "manual"
      ? "manual"
      : normalizeAutopilotExecutor(arg?.autopilotExecutor ?? defaultExecutorForPolicy(executorPolicy));

    // Fast-path for autostart missions: create immediately and launch in the background
    // so renderer IPC does not block on planning/launch work.
    if (autostart) {
      const created = ctx.missionService.create({
        ...arg,
        launchMode: runMode,
        autostart: true,
        autopilotExecutor: defaultExecutorKind
      });

      try {
        await ctx.packService.refreshMissionPack({
          missionId: created.id,
          reason: "mission_created"
        });
      } catch (error) {
        ctx.logger.warn("packs.refresh_mission_pack_failed", {
          missionId: created.id,
          reason: "mission_created",
          error: error instanceof Error ? error.message : String(error)
        });
      }

      void (async () => {
        try {
          const launch = await ctx.aiOrchestratorService.startMissionRun({
            missionId: created.id,
            runMode,
            autopilotOwnerId: "missions-autopilot",
            defaultExecutorKind,
            defaultRetryLimit: 1,
            metadata: {
              launchSource: "missions.create.fast_path",
              plannerEngineRequested: plannerEngine,
              plannerExecutorPolicy: executorPolicy
            }
          });
          if (launch.blockedByPlanReview) {
            ctx.logger.info("missions.autostart_plan_review_blocked", {
              missionId: created.id
            });
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
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

    const planning = await planMissionOnce({
      title,
      prompt,
      laneId,
      plannerEngine,
      timeoutMs: arg?.planningTimeoutMs,
      allowPlanningQuestions: arg?.allowPlanningQuestions,
      projectRoot: ctx.project.rootPath,
      contextBundle: buildMissionPlanningContextBundle({
        ctx,
        laneId,
        executionMode,
        targetMachineId
      }),
      aiIntegrationService: ctx.aiIntegrationService,
      logger: ctx.logger
    });

    const plannedSteps = plannerPlanToMissionSteps({
      plan: planning.plan,
      requestedEngine: planning.run.requestedEngine,
      resolvedEngine: planning.run.resolvedEngine!,
      executorPolicy,
      degraded: planning.run.degraded,
      reasonCode: planning.run.reasonCode,
      validationErrors: planning.run.validationErrors
    });

    const created = ctx.missionService.create({
      ...arg,
      plannedSteps,
      plannerRun: {
        ...planning.run,
        missionId: ""
      },
      plannerPlan: planning.plan
    });
    try {
      await ctx.packService.refreshMissionPack({
        missionId: created.id,
        reason: "mission_created"
      });
    } catch (error) {
      ctx.logger.warn("packs.refresh_mission_pack_failed", {
        missionId: created.id,
        reason: "mission_created",
        error: error instanceof Error ? error.message : String(error)
      });
    }

    const detail = ctx.missionService.get(created.id);
    if (detail) return detail;
    return created;
  });

  ipcMain.handle(IPC.missionsUpdate, async (_event, arg: UpdateMissionArgs): Promise<MissionDetail> => {
    const ctx = getCtx();
    const updated = ctx.missionService.update(arg);
    try {
      await ctx.packService.refreshMissionPack({
        missionId: updated.id,
        reason: "mission_updated"
      });
    } catch (error) {
      ctx.logger.warn("packs.refresh_mission_pack_failed", {
        missionId: updated.id,
        reason: "mission_updated",
        error: error instanceof Error ? error.message : String(error)
      });
    }
    return updated;
  });

  ipcMain.handle(IPC.missionsDelete, async (_event, arg: DeleteMissionArgs): Promise<void> => {
    const ctx = getCtx();
    ctx.missionService.delete(arg);
  });

  ipcMain.handle(IPC.missionsUpdateStep, async (_event, arg: UpdateMissionStepArgs): Promise<MissionStep> => {
    const ctx = getCtx();
    const updated = ctx.missionService.updateStep(arg);
    try {
      await ctx.packService.refreshMissionPack({
        missionId: updated.missionId,
        reason: "mission_step_updated"
      });
    } catch (error) {
      ctx.logger.warn("packs.refresh_mission_pack_failed", {
        missionId: updated.missionId,
        reason: "mission_step_updated",
        error: error instanceof Error ? error.message : String(error)
      });
    }
    return updated;
  });

  ipcMain.handle(IPC.missionsAddArtifact, async (_event, arg: AddMissionArtifactArgs): Promise<MissionArtifact> => {
    const ctx = getCtx();
    const artifact = ctx.missionService.addArtifact(arg);
    try {
      await ctx.packService.refreshMissionPack({
        missionId: artifact.missionId,
        reason: "mission_artifact_added"
      });
    } catch (error) {
      ctx.logger.warn("packs.refresh_mission_pack_failed", {
        missionId: artifact.missionId,
        reason: "mission_artifact_added",
        error: error instanceof Error ? error.message : String(error)
      });
    }
    return artifact;
  });

  ipcMain.handle(
    IPC.missionsAddIntervention,
    async (_event, arg: AddMissionInterventionArgs): Promise<MissionIntervention> => {
      const ctx = getCtx();
      const intervention = ctx.missionService.addIntervention(arg);
      try {
        await ctx.packService.refreshMissionPack({
          missionId: intervention.missionId,
          reason: "mission_intervention_added"
        });
      } catch (error) {
        ctx.logger.warn("packs.refresh_mission_pack_failed", {
          missionId: intervention.missionId,
          reason: "mission_intervention_added",
          error: error instanceof Error ? error.message : String(error)
        });
      }
      return intervention;
    }
  );

  ipcMain.handle(
    IPC.missionsResolveIntervention,
    async (_event, arg: ResolveMissionInterventionArgs): Promise<MissionIntervention> => {
      const ctx = getCtx();
      const intervention = ctx.missionService.resolveIntervention(arg);
      try {
        await ctx.packService.refreshMissionPack({
          missionId: intervention.missionId,
          reason: "mission_intervention_resolved"
        });
      } catch (error) {
        ctx.logger.warn("packs.refresh_mission_pack_failed", {
          missionId: intervention.missionId,
          reason: "mission_intervention_resolved",
          error: error instanceof Error ? error.message : String(error)
        });
      }
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
      const started = await ctx.aiOrchestratorService.startMissionRun({
        missionId: arg.missionId,
        runMode: arg.runMode,
        autopilotOwnerId: arg.autopilotOwnerId,
        defaultExecutorKind: arg.defaultExecutorKind,
        defaultRetryLimit: arg.defaultRetryLimit,
        metadata: arg.metadata ?? null
      });
      if (started.blockedByPlanReview || !started.started) {
        throw new Error("Mission run is blocked pending plan review approval.");
      }
      return started.started;
    }
  );

  ipcMain.handle(
    IPC.orchestratorApproveMissionPlan,
    async (_event, arg: StartOrchestratorRunFromMissionArgs): Promise<{ run: OrchestratorRun; steps: OrchestratorStep[] }> => {
      const ctx = getCtx();
      const started = await ctx.aiOrchestratorService.approveMissionPlan({
        missionId: arg.missionId,
        runMode: arg.runMode,
        autopilotOwnerId: arg.autopilotOwnerId,
        defaultExecutorKind: arg.defaultExecutorKind,
        defaultRetryLimit: arg.defaultRetryLimit,
        metadata: arg.metadata ?? null
      });
      if (started.blockedByPlanReview || !started.started) {
        throw new Error("Mission plan approval did not produce a runnable mission execution.");
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

  ipcMain.handle(IPC.orchestratorResumeRun, async (_event, arg: ResumeOrchestratorRunArgs): Promise<OrchestratorRun> => {
    const ctx = getCtx();
    return ctx.orchestratorService.resumeRun(arg);
  });

  ipcMain.handle(IPC.orchestratorCancelRun, async (_event, arg: CancelOrchestratorRunArgs): Promise<OrchestratorRun> => {
    const ctx = getCtx();
    ctx.orchestratorService.cancelRun(arg);
    const run = ctx.orchestratorService.listRuns({ limit: 1_000 }).find((entry) => entry.id === arg.runId);
    if (!run) throw new Error(`Run not found after cancellation: ${arg.runId}`);
    return run;
  });

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
    IPC.orchestratorGetDepthConfig,
    async (_event, arg: GetMissionDepthConfigArgs): Promise<MissionDepthConfig> => {
      const ctx = getCtx();
      return ctx.aiOrchestratorService.getDepthConfig(arg);
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
    IPC.orchestratorGetMissionMetrics,
    async (_event, arg: GetMissionMetricsArgs): Promise<{ config: MissionMetricsConfig | null; samples: MissionMetricSample[] }> => {
      const ctx = getCtx();
      return ctx.aiOrchestratorService.getMissionMetrics(arg);
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
    IPC.orchestratorSendAgentMessage,
    async (_event, arg: SendAgentMessageArgs): Promise<OrchestratorChatMessage> => {
      const ctx = getCtx();
      return ctx.aiOrchestratorService.sendAgentMessage(arg);
    }
  );

  ipcMain.handle(IPC.getAggregatedUsage, (_e, arg) => {
    const ctx = getCtx();
    return ctx.aiOrchestratorService.getAggregatedUsage(arg ?? {});
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
    return await ctx.laneService.list(arg);
  });

  ipcMain.handle(IPC.lanesCreate, async (_event, arg: CreateLaneArgs): Promise<LaneSummary> => {
    const ctx = getCtx();
    return await ctx.laneService.create({ name: arg.name, description: arg.description, parentLaneId: arg.parentLaneId });
  });

  ipcMain.handle(IPC.lanesCreateChild, async (_event, arg: CreateChildLaneArgs): Promise<LaneSummary> => {
    const ctx = getCtx();
    return await ctx.laneService.createChild(arg);
  });

  ipcMain.handle(IPC.lanesImportBranch, async (_event, arg: ImportBranchLaneArgs): Promise<LaneSummary> => {
    const ctx = getCtx();
    return await ctx.laneService.importBranch(arg);
  });

  ipcMain.handle(IPC.lanesAttach, async (_event, arg: AttachLaneArgs): Promise<LaneSummary> => {
    const ctx = getCtx();
    return await ctx.laneService.attach(arg);
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
  });

  ipcMain.handle(IPC.lanesDelete, async (_event, arg: DeleteLaneArgs): Promise<void> => {
    const ctx = getCtx();
    await ctx.laneService.delete(arg);
  });

  ipcMain.handle(IPC.lanesGetStackChain, async (_event, arg: { laneId: string }): Promise<StackChainItem[]> => {
    const ctx = getCtx();
    return await ctx.laneService.getStackChain(arg.laneId);
  });

  ipcMain.handle(IPC.lanesGetChildren, async (_event, arg: { laneId: string }): Promise<LaneSummary[]> => {
    const ctx = getCtx();
    return await ctx.laneService.getChildren(arg.laneId);
  });

  ipcMain.handle(IPC.lanesRestack, async (_event, arg: RestackArgs): Promise<RestackResult> => {
    const ctx = getCtx();
    return await ctx.laneService.restack(arg);
  });

  ipcMain.handle(IPC.lanesListRestackSuggestions, async (): Promise<RestackSuggestion[]> => {
    const ctx = getCtx();
    if (!ctx.restackSuggestionService) return [];
    return await ctx.restackSuggestionService.listSuggestions();
  });

  ipcMain.handle(IPC.lanesDismissRestackSuggestion, async (_event, arg: { laneId: string }): Promise<void> => {
    const ctx = getCtx();
    if (!ctx.restackSuggestionService) return;
    await ctx.restackSuggestionService.dismiss({ laneId: arg.laneId });
  });

  ipcMain.handle(IPC.lanesDeferRestackSuggestion, async (_event, arg: { laneId: string; minutes: number }): Promise<void> => {
    const ctx = getCtx();
    if (!ctx.restackSuggestionService) return;
    await ctx.restackSuggestionService.defer({ laneId: arg.laneId, minutes: arg.minutes });
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

  ipcMain.handle(IPC.sessionsList, async (_event, arg: ListSessionsArgs): Promise<TerminalSessionSummary[]> => {
    const ctx = getCtx();
    return ctx.ptyService.enrichSessions(ctx.sessionService.list(arg));
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
    return ctx.packService.getSessionDelta(arg.sessionId);
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

  ipcMain.handle(IPC.agentChatListContextPacks, async (_event, arg: ContextPackListArgs = {}): Promise<ContextPackOption[]> => {
    const ctx = getCtx();
    return ctx.agentChatService.listContextPacks(arg);
  });

  ipcMain.handle(IPC.agentChatFetchContextPack, async (_event, arg: ContextPackFetchArgs): Promise<ContextPackFetchResult> => {
    const ctx = getCtx();
    return ctx.agentChatService.fetchContextPack(arg);
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
    return await ctx.fileService.listTree(arg);
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
    return await ctx.conflictService.listProposals({ laneId: arg.laneId });
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

  ipcMain.handle(IPC.conflictsFinalizeResolverSession, async (_event, arg) => getCtx().conflictService.finalizeResolverSession(arg));

  ipcMain.handle(IPC.conflictsSuggestResolverTarget, async (_event, arg) => getCtx().conflictService.suggestResolverTarget(arg));

  ipcMain.handle(IPC.contextGetStatus, async (): Promise<ContextStatus> => {
    const ctx = getCtx();
    return ctx.packService.getContextStatus();
  });

  ipcMain.handle(IPC.contextGetInventory, async (): Promise<ContextInventorySnapshot> => {
    const ctx = getCtx();
    return buildContextInventorySnapshot(ctx);
  });

  ipcMain.handle(IPC.contextGenerateDocs, async (_event, arg: ContextGenerateDocsArgs): Promise<ContextGenerateDocsResult> => {
    const ctx = getCtx();
    return ctx.packService.generateContextDocs(arg);
  });

  ipcMain.handle(IPC.contextPrepareDocGeneration, async (_event, arg: ContextPrepareDocGenArgs): Promise<ContextPrepareDocGenResult> => {
    const ctx = getCtx();
    return ctx.packService.prepareContextDocGeneration(arg);
  });

  ipcMain.handle(IPC.contextInstallGeneratedDocs, async (_event, arg: ContextInstallGeneratedDocsArgs): Promise<ContextGenerateDocsResult> => {
    const ctx = getCtx();
    return ctx.packService.installGeneratedDocs(arg);
  });

  ipcMain.handle(IPC.contextOpenDoc, async (_event, arg: ContextOpenDocArgs): Promise<void> => {
    const ctx = getCtx();
    const explicitPath = typeof arg.path === "string" ? arg.path.trim() : "";
    const target = explicitPath || (arg.docId ? ctx.packService.getContextDocPath(arg.docId) : "");
    if (!target) {
      throw new Error("contextOpenDoc requires docId or path");
    }
    await shell.openPath(target);
  });

  ipcMain.handle(IPC.packsGetProjectPack, async (): Promise<PackSummary> => {
    const ctx = getCtx();
    return ctx.packService.getProjectPack();
  });

  ipcMain.handle(IPC.packsGetLanePack, async (_event, arg: { laneId: string }): Promise<PackSummary> => {
    const ctx = getCtx();
    return ctx.packService.getLanePack(arg.laneId);
  });

  ipcMain.handle(IPC.packsRefreshLanePack, async (_event, arg: { laneId: string }): Promise<PackSummary> => {
    const ctx = getCtx();
    const lanePack = await ctx.packService.refreshLanePack({
      laneId: arg.laneId,
      reason: "manual_refresh"
    });
    await ctx.packService.refreshProjectPack({
      reason: "manual_refresh",
      laneId: arg.laneId
    });
    return lanePack;
  });

  ipcMain.handle(IPC.packsRefreshProjectPack, async (_event, arg: { laneId?: string | null } = {}): Promise<PackSummary> => {
    const ctx = getCtx();
    return await ctx.packService.refreshProjectPack({
      reason: "manual_refresh",
      ...(arg.laneId ? { laneId: arg.laneId } : {})
    });
  });

  ipcMain.handle(IPC.packsRefreshPlanPack, async (_event, arg: { laneId: string }): Promise<PackSummary> => {
    const ctx = getCtx();
    return await ctx.packService.refreshPlanPack({ laneId: arg.laneId, reason: "manual_refresh" });
  });

  ipcMain.handle(IPC.packsGetFeaturePack, async (_event, arg: { featureKey: string }): Promise<PackSummary> => {
    const ctx = getCtx();
    return ctx.packService.getFeaturePack(arg.featureKey);
  });

  ipcMain.handle(
    IPC.packsGetConflictPack,
    async (_event, arg: { laneId: string; peerLaneId?: string | null }): Promise<PackSummary> => {
      const ctx = getCtx();
      return ctx.packService.getConflictPack({ laneId: arg.laneId, peerLaneId: arg.peerLaneId ?? null });
    }
  );

  ipcMain.handle(IPC.packsGetPlanPack, async (_event, arg: { laneId: string }): Promise<PackSummary> => {
    const ctx = getCtx();
    return ctx.packService.getPlanPack(arg.laneId);
  });

  ipcMain.handle(IPC.packsGetMissionPack, async (_event, arg: GetMissionPackArgs): Promise<PackSummary> => {
    const ctx = getCtx();
    return ctx.packService.getMissionPack(arg.missionId);
  });

  ipcMain.handle(IPC.packsGetProjectExport, async (_event, arg: GetProjectExportArgs): Promise<PackExport> => {
    const ctx = getCtx();
    return await ctx.packService.getProjectExport(arg);
  });

  ipcMain.handle(IPC.packsGetLaneExport, async (_event, arg: GetLaneExportArgs): Promise<PackExport> => {
    const ctx = getCtx();
    return await ctx.packService.getLaneExport(arg);
  });

  ipcMain.handle(IPC.packsGetConflictExport, async (_event, arg: GetConflictExportArgs): Promise<PackExport> => {
    const ctx = getCtx();
    return await ctx.packService.getConflictExport(arg);
  });

  ipcMain.handle(IPC.packsGetFeatureExport, async (_event, arg: { featureKey: string; level: ContextExportLevel }): Promise<PackExport> => {
    const ctx = getCtx();
    return await ctx.packService.getFeatureExport(arg);
  });

  ipcMain.handle(IPC.packsGetPlanExport, async (_event, arg: { laneId: string; level: ContextExportLevel }): Promise<PackExport> => {
    const ctx = getCtx();
    return await ctx.packService.getPlanExport(arg);
  });

  ipcMain.handle(IPC.packsGetMissionExport, async (_event, arg: { missionId: string; level: ContextExportLevel }): Promise<PackExport> => {
    const ctx = getCtx();
    return await ctx.packService.getMissionExport(arg);
  });

  ipcMain.handle(IPC.packsGetDeltaDigest, async (_event, arg: PackDeltaDigestArgs): Promise<PackDeltaDigestV1> => {
    const ctx = getCtx();
    return await ctx.packService.getDeltaDigest(arg);
  });

  ipcMain.handle(IPC.packsRefreshFeaturePack, async (_event, arg: { featureKey: string }): Promise<PackSummary> => {
    const ctx = getCtx();
    return await ctx.packService.refreshFeaturePack({ featureKey: arg.featureKey, reason: "manual_refresh" });
  });

  ipcMain.handle(
    IPC.packsRefreshConflictPack,
    async (_event, arg: { laneId: string; peerLaneId?: string | null }): Promise<PackSummary> => {
      const ctx = getCtx();
      return await ctx.packService.refreshConflictPack({
        laneId: arg.laneId,
        peerLaneId: arg.peerLaneId ?? null,
        reason: "manual_refresh"
      });
    }
  );

  ipcMain.handle(IPC.packsSavePlanPack, async (_event, arg: { laneId: string; body: string }): Promise<PackSummary> => {
    const ctx = getCtx();
    return await ctx.packService.savePlanPack({ laneId: arg.laneId, body: arg.body, reason: "manual_save" });
  });

  ipcMain.handle(IPC.packsRefreshMissionPack, async (_event, arg: RefreshMissionPackArgs): Promise<PackSummary> => {
    const ctx = getCtx();
    return await ctx.packService.refreshMissionPack({
      missionId: arg.missionId,
      reason: arg.reason ?? "manual_refresh",
      runId: arg.runId ?? null
    });
  });

  ipcMain.handle(IPC.packsListVersions, async (_event, arg: { packKey: string; limit?: number }): Promise<PackVersionSummary[]> => {
    const ctx = getCtx();
    return ctx.packService.listVersions({ packKey: arg.packKey, limit: arg.limit });
  });

  ipcMain.handle(IPC.packsGetVersion, async (_event, arg: { versionId: string }): Promise<PackVersion> => {
    const ctx = getCtx();
    return ctx.packService.getVersion(arg.versionId);
  });

  ipcMain.handle(
    IPC.packsDiffVersions,
    async (_event, arg: { fromId: string; toId: string }): Promise<string> => {
      const ctx = getCtx();
      return await ctx.packService.diffVersions(arg);
    }
  );

  ipcMain.handle(
    IPC.packsUpdateNarrative,
    async (_event, arg: { packKey: string; narrative: string }): Promise<PackSummary> => {
      const ctx = getCtx();
      return ctx.packService.updateNarrative({ packKey: arg.packKey, narrative: arg.narrative, source: "user" });
    }
  );

  ipcMain.handle(
    IPC.packsListEvents,
    async (_event, arg: { packKey: string; limit?: number }): Promise<PackEvent[]> => {
      const ctx = getCtx();
      return ctx.packService.listEvents({ packKey: arg.packKey, limit: arg.limit });
    }
  );

  ipcMain.handle(
    IPC.packsListEventsSince,
    async (_event, arg: ListPackEventsSinceArgs): Promise<PackEvent[]> => {
      const ctx = getCtx();
      return ctx.packService.listEventsSince(arg);
    }
  );

  ipcMain.handle(
    IPC.packsListCheckpoints,
    async (_event, arg: { laneId?: string; limit?: number } = {}): Promise<Checkpoint[]> => {
      const ctx = getCtx();
      return ctx.packService.listCheckpoints({ laneId: arg.laneId, limit: arg.limit });
    }
  );

  ipcMain.handle(IPC.packsGetHeadVersion, async (_event, arg: { packKey: string }): Promise<PackHeadVersion> => {
    const ctx = getCtx();
    return ctx.packService.getHeadVersion({ packKey: arg.packKey });
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
    return await ctx.prService.createFromLane(arg);
  });

  ipcMain.handle(IPC.prsLinkToLane, async (_event, arg: LinkPrToLaneArgs): Promise<PrSummary> => {
    const ctx = getCtx();
    return await ctx.prService.linkToLane(arg);
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
    return await ctx.prService.updateDescription(arg);
  });

  ipcMain.handle(IPC.prsDelete, async (_event, arg: DeletePrArgs): Promise<DeletePrResult> => {
    const ctx = getCtx();
    return await ctx.prService.delete(arg);
  });

  ipcMain.handle(IPC.prsDraftDescription, async (_event, arg: { laneId: string; model?: string }): Promise<{ title: string; body: string }> => {
    const ctx = getCtx();
    return await ctx.prService.draftDescription(arg.laneId, arg.model);
  });

  ipcMain.handle(IPC.prsLand, async (_event, arg: LandPrArgs): Promise<LandResult> => {
    const ctx = getCtx();
    return await ctx.prService.land(arg);
  });

  ipcMain.handle(IPC.prsLandStack, async (_event, arg: LandStackArgs): Promise<LandResult[]> => {
    const ctx = getCtx();
    return await ctx.prService.landStack(arg);
  });

  ipcMain.handle(IPC.prsOpenInGitHub, async (_event, arg: { prId: string }): Promise<void> => {
    const ctx = getCtx();
    return await ctx.prService.openInGitHub(arg.prId);
  });

  ipcMain.handle(IPC.prsCreateStacked, async (_event, arg: CreateStackedPrsArgs): Promise<CreateStackedPrsResult> => getCtx().prService.createStackedPrs(arg));

  ipcMain.handle(IPC.prsCreateIntegration, async (_event, arg: CreateIntegrationPrArgs): Promise<CreateIntegrationPrResult> => getCtx().prService.createIntegrationPr(arg));

  ipcMain.handle(IPC.prsLandStackEnhanced, async (_event, arg: LandStackEnhancedArgs): Promise<LandResult[]> => getCtx().prService.landStackEnhanced(arg));

  ipcMain.handle(IPC.prsGetConflictAnalysis, async (_event, arg: { prId: string }) => getCtx().prService.getConflictAnalysis(arg.prId));

  ipcMain.handle(IPC.prsGetMergeContext, async (_event, arg: { prId: string }): Promise<PrMergeContext> => getCtx().prService.getMergeContext(arg.prId));

  ipcMain.handle(IPC.prsListWithConflicts, async () => getCtx().prService.listWithConflicts());

  ipcMain.handle(IPC.prsCreateQueue, async (_event, arg: CreateQueuePrsArgs): Promise<CreateQueuePrsResult> => getCtx().prService.createQueuePrs(arg));

  ipcMain.handle(IPC.prsSimulateIntegration, async (_event, arg: SimulateIntegrationArgs): Promise<IntegrationProposal> => getCtx().prService.simulateIntegration(arg));

  ipcMain.handle(IPC.prsCommitIntegration, async (_event, arg: CommitIntegrationArgs): Promise<CreateIntegrationPrResult> => getCtx().prService.commitIntegration(arg));

  ipcMain.handle(IPC.prsListProposals, async (): Promise<IntegrationProposal[]> =>
    getCtx().prService.listIntegrationProposals(),
  );

  ipcMain.handle(IPC.prsUpdateProposal, async (_event, arg: UpdateIntegrationProposalArgs): Promise<void> =>
    getCtx().prService.updateIntegrationProposal(arg),
  );

  ipcMain.handle(IPC.prsDeleteProposal, async (_event, proposalId: string): Promise<void> =>
    getCtx().prService.deleteIntegrationProposal(proposalId),
  );

  ipcMain.handle(IPC.prsLandQueueNext, async (_event, arg: LandQueueNextArgs): Promise<LandResult> => getCtx().prService.landQueueNext(arg));

  ipcMain.handle(IPC.prsGetHealth, async (_event, arg: { prId: string }): Promise<PrHealth> => getCtx().prService.getPrHealth(arg.prId));

  ipcMain.handle(IPC.prsGetQueueState, async (_event, arg: { groupId: string }): Promise<QueueLandingState | null> => getCtx().prService.getQueueState(arg.groupId));

  ipcMain.handle(IPC.prsCreateIntegrationLaneForProposal, async (_event, arg: CreateIntegrationLaneForProposalArgs): Promise<CreateIntegrationLaneForProposalResult> =>
    getCtx().prService.createIntegrationLaneForProposal(arg));

  ipcMain.handle(IPC.prsStartIntegrationResolution, async (_event, arg: StartIntegrationResolutionArgs): Promise<StartIntegrationResolutionResult> =>
    getCtx().prService.startIntegrationResolution(arg));

  ipcMain.handle(IPC.prsGetIntegrationResolutionState, async (_event, arg: { proposalId: string }): Promise<IntegrationResolutionState | null> =>
    getCtx().prService.getIntegrationResolutionState(arg.proposalId));

  ipcMain.handle(IPC.prsRecheckIntegrationStep, async (_event, arg: RecheckIntegrationStepArgs): Promise<RecheckIntegrationStepResult> =>
    getCtx().prService.recheckIntegrationStep(arg));

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

    const exportedAt = new Date().toISOString();
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
}
