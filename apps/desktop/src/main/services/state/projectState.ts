import { app } from "electron";
import path from "node:path";
import type { ProjectInfo } from "../../../shared/types";
import { resolveAdeLayout } from "../../../shared/adeLayout";
import { initializeOrRepairAdeProject } from "../projects/adeProjectService";

export type AdePaths = {
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

function resolveProjectRoot(): string {
  const envRoot = process.env.ADE_PROJECT_ROOT;
  if (envRoot && envRoot.trim().length > 0) {
    return path.resolve(envRoot);
  }

  // Dev default: this assumes `electron .` is run from `apps/desktop`.
  if (process.env.VITE_DEV_SERVER_URL) {
    return path.resolve(process.cwd(), "..", "..");
  }

  // Packaged fallback: keep state somewhere writable until onboarding picks a repo.
  return path.resolve(app.getPath("userData"), "ade-project");
}

export function getProjectInfo(): ProjectInfo {
  const rootPath = resolveProjectRoot();
  return {
    rootPath,
    displayName: path.basename(rootPath),
    baseRef: "main"
  };
}

export function ensureAdeDirs(projectRoot: string): AdePaths {
  const { paths } = initializeOrRepairAdeProject(projectRoot);
  const layout = resolveAdeLayout(projectRoot);
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
    cacheDir: layout.cacheDir,
    artifactsDir: layout.artifactsDir,
    chatSessionsDir: layout.chatSessionsDir,
    chatTranscriptsDir: layout.chatTranscriptsDir,
    orchestratorCacheDir: layout.orchestratorCacheDir,
    missionStateDir: layout.missionStateDir,
  };
}
