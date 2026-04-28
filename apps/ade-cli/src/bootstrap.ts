import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import * as nodePty from "node-pty";
import { createFileLogger, type Logger } from "../../desktop/src/main/services/logging/logger";
import { openKvDb, type AdeDb } from "../../desktop/src/main/services/state/kvDb";
import { detectDefaultBaseRef, toProjectInfo, upsertProjectRow } from "../../desktop/src/main/services/projects/projectService";
import { initializeOrRepairAdeProject } from "../../desktop/src/main/services/projects/adeProjectService";
import { createOperationService } from "../../desktop/src/main/services/history/operationService";
import { createLaneService } from "../../desktop/src/main/services/lanes/laneService";
import { createSessionService } from "../../desktop/src/main/services/sessions/sessionService";
import { createProjectConfigService } from "../../desktop/src/main/services/config/projectConfigService";
import { createConflictService } from "../../desktop/src/main/services/conflicts/conflictService";
import { createGitOperationsService } from "../../desktop/src/main/services/git/gitOperationsService";
import { createDiffService } from "../../desktop/src/main/services/diffs/diffService";
import { createMissionService } from "../../desktop/src/main/services/missions/missionService";
import type { createMissionPreflightService } from "../../desktop/src/main/services/missions/missionPreflightService";
import { createPtyService } from "../../desktop/src/main/services/pty/ptyService";
import { createTestService } from "../../desktop/src/main/services/tests/testService";
import type { createKeybindingsService } from "../../desktop/src/main/services/keybindings/keybindingsService";
import type { createAgentToolsService } from "../../desktop/src/main/services/agentTools/agentToolsService";
import type { createAdeCliService } from "../../desktop/src/main/services/cli/adeCliService";
import type { createDevToolsService } from "../../desktop/src/main/services/devTools/devToolsService";
import type { createOnboardingService } from "../../desktop/src/main/services/onboarding/onboardingService";
import type { createLaneEnvironmentService } from "../../desktop/src/main/services/lanes/laneEnvironmentService";
import type { createLaneTemplateService } from "../../desktop/src/main/services/lanes/laneTemplateService";
import type { createPortAllocationService } from "../../desktop/src/main/services/lanes/portAllocationService";
import type { createLaneProxyService } from "../../desktop/src/main/services/lanes/laneProxyService";
import type { createOAuthRedirectService } from "../../desktop/src/main/services/lanes/oauthRedirectService";
import type { createRuntimeDiagnosticsService } from "../../desktop/src/main/services/lanes/runtimeDiagnosticsService";
import type { createRebaseSuggestionService } from "../../desktop/src/main/services/lanes/rebaseSuggestionService";
import type { createAutoRebaseService } from "../../desktop/src/main/services/lanes/autoRebaseService";
import { createProcessService } from "../../desktop/src/main/services/processes/processService";
import { augmentProcessPathWithShellAndKnownCliDirs, setPathEnvValue } from "../../desktop/src/main/services/ai/cliExecutableResolver";
import type { createAgentChatService } from "../../desktop/src/main/services/chat/agentChatService";
import type { createPrService } from "../../desktop/src/main/services/prs/prService";
import type { createPrSummaryService } from "../../desktop/src/main/services/prs/prSummaryService";
import type { createQueueLandingService } from "../../desktop/src/main/services/prs/queueLandingService";
import { createIssueInventoryService } from "../../desktop/src/main/services/prs/issueInventoryService";
import { createMemoryService } from "../../desktop/src/main/services/memory/memoryService";
import { createCtoStateService } from "../../desktop/src/main/services/cto/ctoStateService";
import { createWorkerAgentService } from "../../desktop/src/main/services/cto/workerAgentService";
import { createWorkerBudgetService } from "../../desktop/src/main/services/cto/workerBudgetService";
import type { createWorkerRevisionService } from "../../desktop/src/main/services/cto/workerRevisionService";
import type { createWorkerHeartbeatService } from "../../desktop/src/main/services/cto/workerHeartbeatService";
import type { createWorkerTaskSessionService } from "../../desktop/src/main/services/cto/workerTaskSessionService";
import type { createLinearCredentialService } from "../../desktop/src/main/services/cto/linearCredentialService";
import type { createOpenclawBridgeService } from "../../desktop/src/main/services/cto/openclawBridgeService";
import type { createFlowPolicyService } from "../../desktop/src/main/services/cto/flowPolicyService";
import type { createLinearDispatcherService } from "../../desktop/src/main/services/cto/linearDispatcherService";
import type { createLinearIssueTracker } from "../../desktop/src/main/services/cto/linearIssueTracker";
import type { createLinearIngressService } from "../../desktop/src/main/services/cto/linearIngressService";
import type { createLinearRoutingService } from "../../desktop/src/main/services/cto/linearRoutingService";
import type { createLinearSyncService } from "../../desktop/src/main/services/cto/linearSyncService";
import { createOrchestratorService } from "../../desktop/src/main/services/orchestrator/orchestratorService";
import { createAiOrchestratorService } from "../../desktop/src/main/services/orchestrator/aiOrchestratorService";
import { createAiIntegrationService } from "../../desktop/src/main/services/ai/aiIntegrationService";
import { createMissionBudgetService } from "../../desktop/src/main/services/orchestrator/missionBudgetService";
import type { createSyncService } from "../../desktop/src/main/services/sync/syncService";
import type { createSyncHostService } from "../../desktop/src/main/services/sync/syncHostService";
import type { createAutomationIngressService } from "../../desktop/src/main/services/automations/automationIngressService";
import type { createGithubService } from "../../desktop/src/main/services/github/githubService";
import type { createFeedbackReporterService } from "../../desktop/src/main/services/feedback/feedbackReporterService";
import type { createUsageTrackingService } from "../../desktop/src/main/services/usage/usageTrackingService";
import type { createBudgetCapService } from "../../desktop/src/main/services/usage/budgetCapService";
import type { createSessionDeltaService } from "../../desktop/src/main/services/sessions/sessionDeltaService";
import type { createAutoUpdateService } from "../../desktop/src/main/services/updates/autoUpdateService";
import {
  createComputerUseArtifactBrokerService,
  type ComputerUseArtifactBrokerService,
} from "../../desktop/src/main/services/computerUse/computerUseArtifactBrokerService";
import type { createFileService } from "../../desktop/src/main/services/files/fileService";
import {
  createAutomationService,
  type AutomationAdeActionRegistry,
} from "../../desktop/src/main/services/automations/automationService";
import { createAutomationPlannerService } from "../../desktop/src/main/services/automations/automationPlannerService";
import {
  ADE_ACTION_ALLOWLIST,
  type AdeActionDomain,
  getAdeActionDomainServices,
  isAllowedAdeAction,
} from "../../desktop/src/main/services/adeActions/registry";
import { createHeadlessLinearServices } from "./headlessLinearServices";
import { createEventBuffer, type BufferedEvent, type EventBuffer } from "./eventBuffer";

export { createEventBuffer, type BufferedEvent, type EventBuffer };

export type AdeRuntimePaths = {
  adeDir: string;
  logsDir: string;
  processLogsDir: string;
  testLogsDir: string;
  transcriptsDir: string;
  worktreesDir: string;
  packsDir: string;
  dbPath: string;
  socketPath: string;
  cacheDir: string;
  artifactsDir: string;
  chatSessionsDir: string;
  chatTranscriptsDir: string;
  orchestratorCacheDir: string;
  missionStateDir: string;
};

export type AdeRuntime = {
  projectRoot: string;
  workspaceRoot: string;
  projectId: string;
  project: { rootPath: string; displayName: string; baseRef: string };
  paths: AdeRuntimePaths;
  logger: Logger;
  db: AdeDb;
  keybindingsService?: ReturnType<typeof createKeybindingsService> | null;
  agentToolsService?: ReturnType<typeof createAgentToolsService> | null;
  adeCliService?: ReturnType<typeof createAdeCliService> | null;
  devToolsService?: ReturnType<typeof createDevToolsService> | null;
  onboardingService?: ReturnType<typeof createOnboardingService> | null;
  laneService: ReturnType<typeof createLaneService>;
  laneEnvironmentService?: ReturnType<typeof createLaneEnvironmentService> | null;
  laneTemplateService?: ReturnType<typeof createLaneTemplateService> | null;
  portAllocationService?: ReturnType<typeof createPortAllocationService> | null;
  laneProxyService?: ReturnType<typeof createLaneProxyService> | null;
  oauthRedirectService?: ReturnType<typeof createOAuthRedirectService> | null;
  runtimeDiagnosticsService?: ReturnType<typeof createRuntimeDiagnosticsService> | null;
  rebaseSuggestionService?: ReturnType<typeof createRebaseSuggestionService> | null;
  autoRebaseService?: ReturnType<typeof createAutoRebaseService> | null;
  sessionService: ReturnType<typeof createSessionService>;
  operationService: ReturnType<typeof createOperationService>;
  projectConfigService: ReturnType<typeof createProjectConfigService>;
  conflictService: ReturnType<typeof createConflictService>;
  gitService: ReturnType<typeof createGitOperationsService>;
  diffService: ReturnType<typeof createDiffService>;
  missionService: ReturnType<typeof createMissionService>;
  missionPreflightService?: ReturnType<typeof createMissionPreflightService> | null;
  ptyService: ReturnType<typeof createPtyService>;
  testService: ReturnType<typeof createTestService>;
  aiIntegrationService?: ReturnType<typeof createAiIntegrationService> | null;
  agentChatService?: ReturnType<typeof createAgentChatService> | null;
  prService?: ReturnType<typeof createPrService>;
  prSummaryService?: ReturnType<typeof createPrSummaryService> | null;
  queueLandingService?: ReturnType<typeof createQueueLandingService> | null;
  issueInventoryService: ReturnType<typeof createIssueInventoryService>;
  fileService?: ReturnType<typeof createFileService> | null;
  memoryService: ReturnType<typeof createMemoryService>;
  ctoStateService: ReturnType<typeof createCtoStateService>;
  workerAgentService: ReturnType<typeof createWorkerAgentService>;
  workerBudgetService?: ReturnType<typeof createWorkerBudgetService> | null;
  workerRevisionService?: ReturnType<typeof createWorkerRevisionService> | null;
  workerHeartbeatService?: ReturnType<typeof createWorkerHeartbeatService> | null;
  workerTaskSessionService?: ReturnType<typeof createWorkerTaskSessionService> | null;
  linearCredentialService?: ReturnType<typeof createLinearCredentialService> | null;
  openclawBridgeService?: ReturnType<typeof createOpenclawBridgeService> | null;
  flowPolicyService?: ReturnType<typeof createFlowPolicyService> | null;
  linearDispatcherService?: ReturnType<typeof createLinearDispatcherService> | null;
  linearIssueTracker?: ReturnType<typeof createLinearIssueTracker> | null;
  linearSyncService?: ReturnType<typeof createLinearSyncService> | null;
  linearIngressService?: ReturnType<typeof createLinearIngressService> | null;
  linearRoutingService?: ReturnType<typeof createLinearRoutingService> | null;
  processService?: ReturnType<typeof createProcessService> | null;
  githubService?: ReturnType<typeof createGithubService> | null;
  automationService?: ReturnType<typeof createAutomationService> | null;
  automationPlannerService?: ReturnType<typeof createAutomationPlannerService> | null;
  computerUseArtifactBrokerService: ComputerUseArtifactBrokerService;
  orchestratorService: ReturnType<typeof createOrchestratorService>;
  aiOrchestratorService: ReturnType<typeof createAiOrchestratorService>;
  missionBudgetService?: ReturnType<typeof createMissionBudgetService> | null;
  syncHostService?: ReturnType<typeof createSyncHostService> | null;
  syncService?: ReturnType<typeof createSyncService> | null;
  automationIngressService?: ReturnType<typeof createAutomationIngressService> | null;
  feedbackReporterService?: ReturnType<typeof createFeedbackReporterService> | null;
  usageTrackingService?: ReturnType<typeof createUsageTrackingService> | null;
  budgetCapService?: ReturnType<typeof createBudgetCapService> | null;
  sessionDeltaService?: ReturnType<typeof createSessionDeltaService> | null;
  autoUpdateService?: ReturnType<typeof createAutoUpdateService> | null;
  eventBuffer: EventBuffer;
  dispose: () => void;
};

export function ensureAdePaths(projectRoot: string): AdeRuntimePaths {
  const { paths } = initializeOrRepairAdeProject(projectRoot);
  return {
    adeDir: paths.adeDir,
    logsDir: paths.logsDir,
    processLogsDir: paths.processLogsDir,
    testLogsDir: paths.testLogsDir,
    transcriptsDir: paths.transcriptsDir,
    worktreesDir: paths.worktreesDir,
    packsDir: paths.packsDir,
    dbPath: paths.dbPath,
    socketPath: paths.socketPath,
    cacheDir: paths.cacheDir,
    artifactsDir: paths.artifactsDir,
    chatSessionsDir: paths.chatSessionsDir,
    chatTranscriptsDir: paths.chatTranscriptsDir,
    orchestratorCacheDir: paths.orchestratorCacheDir,
    missionStateDir: paths.missionStateDir,
  };
}

function createHeadlessAdeCliAgentEnv(baseEnv: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const next: NodeJS.ProcessEnv = { ...baseEnv };
  const nextPath = augmentProcessPathWithShellAndKnownCliDirs({
    env: next,
    includeInteractiveShell: true,
    timeoutMs: 1_000,
  });
  if (nextPath) setPathEnvValue(next, nextPath);
  return next;
}

export async function createAdeRuntime(args: { projectRoot: string; workspaceRoot?: string } | string): Promise<AdeRuntime> {
  const resolvedArgs = typeof args === "string"
    ? { projectRoot: args, workspaceRoot: args }
    : args;
  const projectRoot = path.resolve(resolvedArgs.projectRoot);
  const workspaceRoot = path.resolve(resolvedArgs.workspaceRoot ?? resolvedArgs.projectRoot);
  if (!fs.existsSync(projectRoot) || !fs.statSync(projectRoot).isDirectory()) {
    throw new Error(`Project root does not exist: ${projectRoot}`);
  }
  if (!fs.existsSync(workspaceRoot) || !fs.statSync(workspaceRoot).isDirectory()) {
    throw new Error(`Workspace root does not exist: ${workspaceRoot}`);
  }

  const baseRef = await detectDefaultBaseRef(projectRoot);
  const paths = ensureAdePaths(projectRoot);
  const logger = createFileLogger(path.join(paths.logsDir, "ade-cli.jsonl"));
  const db = await openKvDb(paths.dbPath, logger);

  const project = toProjectInfo(projectRoot, baseRef);
  const { projectId } = upsertProjectRow({
    db,
    repoRoot: projectRoot,
    displayName: project.displayName,
    baseRef
  });

  const operationService = createOperationService({ db, projectId });

  const laneService = createLaneService({
    db,
    projectRoot,
    projectId,
    defaultBaseRef: baseRef,
    worktreesDir: paths.worktreesDir,
    operationService
  });
  await laneService.ensurePrimaryLane();

  const sessionService = createSessionService({ db });
  sessionService.reconcileStaleRunningSessions({
    status: "disposed",
    excludeToolTypes: ["claude-chat", "codex-chat", "opencode-chat", "cursor"],
  });

  const projectConfigService = createProjectConfigService({
    projectRoot,
    adeDir: paths.adeDir,
    projectId,
    db,
    logger
  });

  const aiIntegrationService = createAiIntegrationService({
    db,
    logger,
    projectConfigService,
    projectRoot,
    enableDynamicModelMetadata: false,
  });

  const conflictService = createConflictService({
    db,
    logger,
    projectId,
    projectRoot,
    laneService,
    projectConfigService,
    operationService,
    conflictPacksDir: path.join(paths.packsDir, "conflicts"),
    onEvent: () => {}
  });

  const gitService = createGitOperationsService({
    laneService,
    operationService,
    projectConfigService,
    aiIntegrationService,
    logger
  });

  const diffService = createDiffService({ laneService });

  const missionService = createMissionService({
    db,
    projectId,
    onEvent: () => {}
  });

  const ptyService = createPtyService({
    projectRoot,
    transcriptsDir: paths.transcriptsDir,
    laneService,
    sessionService,
    logger,
    broadcastData: () => {},
    broadcastExit: () => {},
    onSessionEnded: () => {},
    getAdeCliAgentEnv: createHeadlessAdeCliAgentEnv,
    loadPty: () => nodePty
  });

  const testService = createTestService({
    db,
    projectId,
    testLogsDir: paths.testLogsDir,
    logger,
    laneService,
    projectConfigService,
    broadcastEvent: () => {}
  });
  const issueInventoryService = createIssueInventoryService({ db });
  const eventBuffer = createEventBuffer();

  function pushEvent(category: BufferedEvent["category"], payload: Record<string, unknown>): void {
    eventBuffer.push({ timestamp: new Date().toISOString(), category, payload });
  }

  // Headless lane runtime env. Unlike the desktop path (which leases ports via
  // portAllocationService and builds collision-safe hostnames via
  // laneProxyService), headless has no persistent allocator wired in — so we
  // derive ports and hostname suffix from a stable hash of the laneId. This is
  // (a) independent of the lane's current list position (archival/reordering
  // no longer shifts a lane's PORT) and (b) resistant to slug collisions
  // between lanes whose display names slugify to the same string.
  // Range matches desktop: basePort=3000, portsPerLane=100, maxPort=9999 → 70 slots.
  const HEADLESS_BASE_PORT = 3000;
  const HEADLESS_PORTS_PER_LANE = 100;
  const HEADLESS_MAX_SLOTS = 70;
  const getHeadlessLaneRuntimeEnv = async (laneId: string): Promise<Record<string, string>> => {
    const lanes = await laneService.list({ includeArchived: false, includeStatus: false });
    const lane = lanes.find((entry) => entry.id === laneId);
    const laneHash = createHash("sha256").update(laneId).digest();
    const slotIndex = laneHash.readUInt32BE(0) % HEADLESS_MAX_SLOTS;
    const portStart = HEADLESS_BASE_PORT + slotIndex * HEADLESS_PORTS_PER_LANE;
    const portEnd = portStart + HEADLESS_PORTS_PER_LANE - 1;
    const baseSlug = (lane?.name ?? lane?.branchRef ?? laneId)
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "lane";
    // 6-char suffix from the laneId hash keeps hostnames readable while making
    // two lanes with identical slugs resolve to distinct hostnames.
    const idSuffix = laneHash.toString("hex").slice(0, 6);
    const hostname = `${baseSlug}-${idSuffix}.localhost`;
    return {
      PORT: String(portStart),
      PORT_RANGE_START: String(portStart),
      PORT_RANGE_END: String(portEnd),
      HOSTNAME: hostname,
      PROXY_HOSTNAME: hostname,
    };
  };

  const processService = createProcessService({
    db,
    projectId,
    logger,
    laneService,
    projectConfigService,
    sessionService,
    ptyService,
    getLaneRuntimeEnv: getHeadlessLaneRuntimeEnv,
    broadcastEvent: (event) => pushEvent("runtime", event as unknown as Record<string, unknown>),
  });

  // Ensure evaluation tables exist for headless runtime checks.
  db.run(`
    CREATE TABLE IF NOT EXISTS orchestrator_evaluations (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      mission_id TEXT NOT NULL,
      evaluator_id TEXT NOT NULL,
      scores_json TEXT NOT NULL,
      issues_json TEXT NOT NULL,
      summary TEXT NOT NULL,
      improvements_json TEXT,
      metadata_json TEXT,
      evaluated_at TEXT NOT NULL
    )
  `);
  db.run(`
    CREATE INDEX IF NOT EXISTS idx_orchestrator_evaluations_mission
    ON orchestrator_evaluations(mission_id, evaluated_at)
  `);
  db.run(`
    CREATE INDEX IF NOT EXISTS idx_orchestrator_evaluations_run
    ON orchestrator_evaluations(run_id, evaluated_at)
  `);

  const memoryService = createMemoryService(db);
  const ctoStateService = createCtoStateService({
    db,
    projectId,
    adeDir: paths.adeDir,
  });
  const workerAgentService = createWorkerAgentService({
    db,
    projectId,
    adeDir: paths.adeDir,
  });
  const workerBudgetService = createWorkerBudgetService({
    db,
    projectId,
    workerAgentService,
    projectConfigService,
  });
  const missionBudgetService = createMissionBudgetService({
    db,
    logger,
    projectId,
    projectRoot,
    missionService,
    aiIntegrationService,
    projectConfigService,
  });

  const orchestratorService = createOrchestratorService({
    db,
    projectId,
    projectRoot,
    conflictService,
    ptyService,
    prService: undefined,
    projectConfigService,
    memoryService,
    onEvent: (e) => {
      pushEvent("orchestrator", e as unknown as Record<string, unknown>);
      if (
        e.reason === "validation_contract_unfulfilled" ||
        e.reason === "validation_self_check_reminder" ||
        e.reason === "validation_auto_spawned" ||
        e.reason === "validation_gate_blocked"
      ) {
        pushEvent("runtime", {
          type: e.reason,
          runId: e.runId ?? null,
          stepId: e.stepId ?? null,
          attemptId: e.attemptId ?? null,
        });
      }
    }
  });

  const computerUseArtifactBrokerService = createComputerUseArtifactBrokerService({
    db,
    projectId,
    projectRoot,
    missionService,
    orchestratorService,
    logger,
  });

  const aiOrchestratorService = createAiOrchestratorService({
    db,
    logger,
    missionService,
    orchestratorService,
    agentChatService: null,
    laneService,
    projectConfigService,
    aiIntegrationService,
    prService: undefined,
    projectRoot,
    onThreadEvent: (e) => pushEvent("runtime", e as unknown as Record<string, unknown>),
    onDagMutation: (e) => pushEvent("dag_mutation", e as unknown as Record<string, unknown>)
  });

  const headlessLinearServices = createHeadlessLinearServices({
    projectRoot,
    adeDir: paths.adeDir,
    paths,
    projectId,
    db,
    logger,
    projectConfigService,
    laneService,
    operationService,
    conflictService,
    missionService,
    aiOrchestratorService,
    workerAgentService,
    workerBudgetService,
    computerUseArtifactBrokerService,
    orchestratorService,
    openExternal: async () => {},
  });

  const agentChatService = headlessLinearServices.agentChatService as unknown as ReturnType<typeof createAgentChatService> | null;
  const automationService = createAutomationService({
    db,
    logger,
    projectId,
    projectRoot,
    laneService,
    projectConfigService,
    conflictService,
    testService,
    agentChatService: agentChatService ?? undefined,
    missionService,
    aiOrchestratorService,
    onEvent: (event) => pushEvent("runtime", { ...event, source: "automations" }),
  });
  const automationPlannerService = createAutomationPlannerService({
    logger,
    projectRoot,
    projectConfigService,
    laneService,
    automationService,
  });

  const runtime: AdeRuntime = {
    projectRoot,
    workspaceRoot,
    projectId,
    project,
    paths,
    logger,
    db,
    laneService,
    sessionService,
    operationService,
    projectConfigService,
    conflictService,
    gitService,
    diffService,
    missionService,
    missionBudgetService,
    ptyService,
    testService,
    aiIntegrationService,
    agentChatService,
    issueInventoryService,
    memoryService,
    ctoStateService,
    workerAgentService,
    workerBudgetService,
    githubService: headlessLinearServices.githubService as never,
    workerTaskSessionService: headlessLinearServices.workerTaskSessionService,
    workerHeartbeatService: headlessLinearServices.workerHeartbeatService,
    linearCredentialService: headlessLinearServices.linearCredentialService as never,
    prService: headlessLinearServices.prService,
    fileService: headlessLinearServices.fileService,
    flowPolicyService: headlessLinearServices.flowPolicyService,
    linearDispatcherService: headlessLinearServices.linearDispatcherService,
    linearIssueTracker: headlessLinearServices.linearIssueTracker,
    linearSyncService: headlessLinearServices.linearSyncService,
    linearIngressService: headlessLinearServices.linearIngressService,
    linearRoutingService: headlessLinearServices.linearRoutingService,
    processService,
    automationService,
    automationPlannerService,
    computerUseArtifactBrokerService,
    orchestratorService,
    aiOrchestratorService,
    eventBuffer,
    dispose: () => {
      const swallow = (fn: () => void) => { try { fn(); } catch { /* ignore */ } };
      swallow(() => automationService.dispose());
      swallow(() => processService.disposeAll());
      swallow(() => headlessLinearServices.dispose());
      swallow(() => aiOrchestratorService.dispose());
      swallow(() => testService.disposeAll());
      swallow(() => ptyService.disposeAll());
      swallow(() => db.flushNow());
      swallow(() => db.close());
    }
  };

  const adeActionLookup: AutomationAdeActionRegistry = {
    isAllowed(domain: string, action: string): boolean {
      return isAllowedAdeAction(domain as AdeActionDomain, action);
    },
    getService(domain: string): Record<string, unknown> | null {
      const services = getAdeActionDomainServices(runtime);
      return (services[domain as AdeActionDomain] ?? null) as Record<string, unknown> | null;
    },
    listDomains(): string[] {
      return Object.keys(ADE_ACTION_ALLOWLIST);
    },
    listActions(domain: string): string[] {
      return [...(ADE_ACTION_ALLOWLIST[domain as AdeActionDomain] ?? [])];
    },
  };
  automationService.bindAdeActionRegistry(adeActionLookup);

  return runtime;
}
