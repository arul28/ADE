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
    packService,
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
    dispose: () => {
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
