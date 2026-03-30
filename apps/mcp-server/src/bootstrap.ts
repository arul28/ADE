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
import { createPtyService } from "../../desktop/src/main/services/pty/ptyService";
import { createTestService } from "../../desktop/src/main/services/tests/testService";
import type { createAgentChatService } from "../../desktop/src/main/services/chat/agentChatService";
import type { createPrService } from "../../desktop/src/main/services/prs/prService";
import { createMemoryService } from "../../desktop/src/main/services/memory/memoryService";
import { createCtoStateService } from "../../desktop/src/main/services/cto/ctoStateService";
import { createWorkerAgentService } from "../../desktop/src/main/services/cto/workerAgentService";
import { createWorkerBudgetService } from "../../desktop/src/main/services/cto/workerBudgetService";
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
import { createExternalMcpService, type ExternalMcpService } from "../../desktop/src/main/services/externalMcp/externalMcpService";
import {
  createComputerUseArtifactBrokerService,
  type ComputerUseArtifactBrokerService,
} from "../../desktop/src/main/services/computerUse/computerUseArtifactBrokerService";
import type { createFileService } from "../../desktop/src/main/services/files/fileService";
import type { createProcessService } from "../../desktop/src/main/services/processes/processService";
import { createHeadlessLinearServices } from "./headlessLinearServices";

// ── Event Buffer ─────────────────────────────────────────────────
// In-memory ring buffer for event streaming (10K cap, FIFO eviction).
// Stores orchestrator events, DAG mutations, and runtime events with monotonic cursor IDs.

export type BufferedEvent = {
  id: number;
  timestamp: string;
  category: "orchestrator" | "dag_mutation" | "runtime" | "mission";
  payload: Record<string, unknown>;
};

export type EventBuffer = {
  push(event: Omit<BufferedEvent, "id">): void;
  drain(cursor: number, limit?: number): { events: BufferedEvent[]; nextCursor: number; hasMore: boolean };
  size(): number;
};

export function createEventBuffer(capacity = 10_000): EventBuffer {
  const events: BufferedEvent[] = [];
  let nextId = 1;

  return {
    push(event) {
      const entry: BufferedEvent = { id: nextId++, ...event };
      events.push(entry);
      while (events.length > capacity) {
        events.shift();
      }
    },
    drain(cursor, limit = 100) {
      const clamped = Math.max(1, Math.min(1000, limit));
      const startIdx = events.findIndex((e) => e.id > cursor);
      if (startIdx === -1) {
        return { events: [], nextCursor: cursor, hasMore: false };
      }
      const slice = events.slice(startIdx, startIdx + clamped);
      const lastId = slice.length > 0 ? slice[slice.length - 1]!.id : cursor;
      return {
        events: slice,
        nextCursor: lastId,
        hasMore: startIdx + clamped < events.length
      };
    },
    size() {
      return events.length;
    }
  };
}

export type AdeMcpPaths = {
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

export type AdeMcpRuntime = {
  projectRoot: string;
  workspaceRoot: string;
  projectId: string;
  project: { rootPath: string; displayName: string; baseRef: string };
  paths: AdeMcpPaths;
  logger: Logger;
  db: AdeDb;
  laneService: ReturnType<typeof createLaneService>;
  sessionService: ReturnType<typeof createSessionService>;
  operationService: ReturnType<typeof createOperationService>;
  projectConfigService: ReturnType<typeof createProjectConfigService>;
  conflictService: ReturnType<typeof createConflictService>;
  gitService: ReturnType<typeof createGitOperationsService>;
  diffService: ReturnType<typeof createDiffService>;
  missionService: ReturnType<typeof createMissionService>;
  ptyService: ReturnType<typeof createPtyService>;
  testService: ReturnType<typeof createTestService>;
  agentChatService?: ReturnType<typeof createAgentChatService> | null;
  prService?: ReturnType<typeof createPrService>;
  fileService?: ReturnType<typeof createFileService> | null;
  memoryService: ReturnType<typeof createMemoryService>;
  ctoStateService: ReturnType<typeof createCtoStateService>;
  workerAgentService: ReturnType<typeof createWorkerAgentService>;
  flowPolicyService?: ReturnType<typeof createFlowPolicyService> | null;
  linearDispatcherService?: ReturnType<typeof createLinearDispatcherService> | null;
  linearIssueTracker?: ReturnType<typeof createLinearIssueTracker> | null;
  linearSyncService?: ReturnType<typeof createLinearSyncService> | null;
  linearIngressService?: ReturnType<typeof createLinearIngressService> | null;
  linearRoutingService?: ReturnType<typeof createLinearRoutingService> | null;
  processService?: ReturnType<typeof createProcessService> | null;
  externalMcpService: ExternalMcpService;
  computerUseArtifactBrokerService: ComputerUseArtifactBrokerService;
  orchestratorService: ReturnType<typeof createOrchestratorService>;
  aiOrchestratorService: ReturnType<typeof createAiOrchestratorService>;
  eventBuffer: EventBuffer;
  dispose: () => void;
};

export function ensureAdePaths(projectRoot: string): AdeMcpPaths {
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

export async function createAdeMcpRuntime(args: { projectRoot: string; workspaceRoot?: string } | string): Promise<AdeMcpRuntime> {
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
  const logger = createFileLogger(path.join(paths.logsDir, "mcp-server.jsonl"));
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
  sessionService.reconcileStaleRunningSessions({ status: "disposed" });

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

  // Ensure MCP-specific tables exist (evaluation framework)
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

  const eventBuffer = createEventBuffer();

  function pushEvent(category: BufferedEvent["category"], payload: Record<string, unknown>): void {
    eventBuffer.push({ timestamp: new Date().toISOString(), category, payload });
  }

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
  const externalMcpService = createExternalMcpService({
    projectRoot,
    adeDir: paths.adeDir,
    db,
    projectId,
    logger,
    workerAgentService,
    ctoStateService,
    missionService,
    workerBudgetService,
    missionBudgetService,
  });
  try {
    await externalMcpService.start();
  } catch (error) {
    logger.warn("external_mcp.bootstrap_start_failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
  const externalMcpConfigWatcher = (() => {
    try {
      return fs.watch(paths.adeDir, (_eventType, fileName) => {
        if (String(fileName ?? "").trim() !== "local.secret.yaml") return;
        externalMcpService.reload();
      });
    } catch (error) {
      logger.warn("external_mcp.bootstrap_watch_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  })();

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
    externalMcpService,
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
    externalMcpService,
    computerUseArtifactBrokerService,
    orchestratorService,
    openExternal: async () => {},
  });

  return {
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
    ptyService,
    testService,
    agentChatService: headlessLinearServices.agentChatService as unknown as ReturnType<typeof createAgentChatService> | null,
    memoryService,
    ctoStateService,
    workerAgentService,
    prService: headlessLinearServices.prService,
    fileService: headlessLinearServices.fileService,
    flowPolicyService: headlessLinearServices.flowPolicyService,
    linearDispatcherService: headlessLinearServices.linearDispatcherService,
    linearIssueTracker: headlessLinearServices.linearIssueTracker,
    linearSyncService: headlessLinearServices.linearSyncService,
    linearIngressService: headlessLinearServices.linearIngressService,
    linearRoutingService: headlessLinearServices.linearRoutingService,
    processService: headlessLinearServices.processService,
    externalMcpService,
    computerUseArtifactBrokerService,
    orchestratorService,
    aiOrchestratorService,
    eventBuffer,
    dispose: () => {
      const swallow = (fn: () => void) => { try { fn(); } catch { /* ignore */ } };
      swallow(() => headlessLinearServices.dispose());
      swallow(() => externalMcpConfigWatcher?.close());
      void externalMcpService.dispose().catch(() => {});
      swallow(() => aiOrchestratorService.dispose());
      swallow(() => testService.disposeAll());
      swallow(() => ptyService.disposeAll());
      swallow(() => db.flushNow());
      swallow(() => db.close());
    }
  };
}
