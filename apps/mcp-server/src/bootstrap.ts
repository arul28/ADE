import fs from "node:fs";
import path from "node:path";
import * as nodePty from "node-pty";
import { createFileLogger, type Logger } from "../../desktop/src/main/services/logging/logger";
import { openKvDb, type AdeDb } from "../../desktop/src/main/services/state/kvDb";
import { detectDefaultBaseRef, toProjectInfo, upsertProjectRow } from "../../desktop/src/main/services/projects/projectService";
import { createOperationService } from "../../desktop/src/main/services/history/operationService";
import { createLaneService } from "../../desktop/src/main/services/lanes/laneService";
import { createSessionService } from "../../desktop/src/main/services/sessions/sessionService";
import { createProjectConfigService } from "../../desktop/src/main/services/config/projectConfigService";
import { createPackService } from "../../desktop/src/main/services/packs/packService";
import { createConflictService } from "../../desktop/src/main/services/conflicts/conflictService";
import { createGitOperationsService } from "../../desktop/src/main/services/git/gitOperationsService";
import { createDiffService } from "../../desktop/src/main/services/diffs/diffService";
import { createMissionService } from "../../desktop/src/main/services/missions/missionService";
import { createPtyService } from "../../desktop/src/main/services/pty/ptyService";
import { createTestService } from "../../desktop/src/main/services/tests/testService";
import type { createPrService } from "../../desktop/src/main/services/prs/prService";
import { createMemoryService } from "../../desktop/src/main/services/memory/memoryService";
import { createCtoStateService } from "../../desktop/src/main/services/cto/ctoStateService";
import { createWorkerAgentService } from "../../desktop/src/main/services/cto/workerAgentService";
import { createOrchestratorService } from "../../desktop/src/main/services/orchestrator/orchestratorService";
import { createAiOrchestratorService } from "../../desktop/src/main/services/orchestrator/aiOrchestratorService";
import { createAiIntegrationService } from "../../desktop/src/main/services/ai/aiIntegrationService";

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
};

export type AdeMcpRuntime = {
  projectRoot: string;
  projectId: string;
  project: { rootPath: string; displayName: string; baseRef: string };
  paths: AdeMcpPaths;
  logger: Logger;
  db: AdeDb;
  laneService: ReturnType<typeof createLaneService>;
  sessionService: ReturnType<typeof createSessionService>;
  operationService: ReturnType<typeof createOperationService>;
  projectConfigService: ReturnType<typeof createProjectConfigService>;
  packService: ReturnType<typeof createPackService>;
  conflictService: ReturnType<typeof createConflictService>;
  gitService: ReturnType<typeof createGitOperationsService>;
  diffService: ReturnType<typeof createDiffService>;
  missionService: ReturnType<typeof createMissionService>;
  ptyService: ReturnType<typeof createPtyService>;
  testService: ReturnType<typeof createTestService>;
  prService?: ReturnType<typeof createPrService>;
  memoryService: ReturnType<typeof createMemoryService>;
  ctoStateService: ReturnType<typeof createCtoStateService>;
  workerAgentService: ReturnType<typeof createWorkerAgentService>;
  orchestratorService: ReturnType<typeof createOrchestratorService>;
  aiOrchestratorService: ReturnType<typeof createAiOrchestratorService>;
  eventBuffer: EventBuffer;
  dispose: () => void;
};

export function ensureAdePaths(projectRoot: string): AdeMcpPaths {
  const adeDir = path.join(projectRoot, ".ade");
  const logsDir = path.join(adeDir, "logs");
  const processLogsDir = path.join(logsDir, "processes");
  const testLogsDir = path.join(logsDir, "tests");
  const transcriptsDir = path.join(adeDir, "transcripts");
  const worktreesDir = path.join(adeDir, "worktrees");
  const packsDir = path.join(adeDir, "packs");
  const dbPath = path.join(adeDir, "ade.db");

  fs.mkdirSync(processLogsDir, { recursive: true });
  fs.mkdirSync(testLogsDir, { recursive: true });
  fs.mkdirSync(transcriptsDir, { recursive: true });
  fs.mkdirSync(worktreesDir, { recursive: true });
  fs.mkdirSync(packsDir, { recursive: true });

  return {
    adeDir,
    logsDir,
    processLogsDir,
    testLogsDir,
    transcriptsDir,
    worktreesDir,
    packsDir,
    dbPath
  };
}

export async function createAdeMcpRuntime(projectRootInput: string): Promise<AdeMcpRuntime> {
  const projectRoot = path.resolve(projectRootInput);
  if (!fs.existsSync(projectRoot) || !fs.statSync(projectRoot).isDirectory()) {
    throw new Error(`Project root does not exist: ${projectRoot}`);
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

  const aiIntegrationService = createAiIntegrationService({ db, logger, projectConfigService });

  const packService = createPackService({
    db,
    logger,
    projectRoot,
    projectId,
    packsDir: paths.packsDir,
    laneService,
    sessionService,
    projectConfigService,
    operationService,
    onEvent: () => {}
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

  const orchestratorService = createOrchestratorService({
    db,
    projectId,
    projectRoot,
    packService,
    conflictService,
    ptyService,
    prService: undefined,
    projectConfigService,
    memoryService,
    onEvent: (e) => {
      eventBuffer.push({
        timestamp: new Date().toISOString(),
        category: "orchestrator",
        payload: e as unknown as Record<string, unknown>
      });
      if (
        e.reason === "validation_contract_unfulfilled" ||
        e.reason === "validation_self_check_reminder" ||
        e.reason === "validation_auto_spawned" ||
        e.reason === "validation_gate_blocked"
      ) {
        eventBuffer.push({
          timestamp: new Date().toISOString(),
          category: "runtime",
          payload: {
            type: e.reason,
            runId: e.runId ?? null,
            stepId: e.stepId ?? null,
            attemptId: e.attemptId ?? null,
          }
        });
      }
    }
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
    onThreadEvent: (e) => {
      eventBuffer.push({
        timestamp: new Date().toISOString(),
        category: "runtime",
        payload: e as unknown as Record<string, unknown>
      });
    },
    onDagMutation: (e) => {
      eventBuffer.push({
        timestamp: new Date().toISOString(),
        category: "dag_mutation",
        payload: e as unknown as Record<string, unknown>
      });
    }
  });

  return {
    projectRoot,
    projectId,
    project,
    paths,
    logger,
    db,
    laneService,
    sessionService,
    operationService,
    projectConfigService,
    packService,
    conflictService,
    gitService,
    diffService,
    missionService,
    ptyService,
    testService,
    memoryService,
    ctoStateService,
    workerAgentService,
    orchestratorService,
    aiOrchestratorService,
    eventBuffer,
    dispose: () => {
      try {
        aiOrchestratorService.dispose();
      } catch {
        // ignore
      }
      try {
        testService.disposeAll();
      } catch {
        // ignore
      }
      try {
        ptyService.disposeAll();
      } catch {
        // ignore
      }
      try {
        db.flushNow();
      } catch {
        // ignore
      }
      try {
        db.close();
      } catch {
        // ignore
      }
    }
  };
}
