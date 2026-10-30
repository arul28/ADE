import path from "node:path";
import { clipboard, shell } from "electron";

import { resolveMachineAdeLayout } from "../../../../../ade-cli/src/services/projects/machineLayout";
import { fetchReleaseManifestJson } from "../../../../../ade-cli/src/lib/releaseAssets";
import { RELEASE_MANIFEST_ASSET } from "../../../shared/updateTrack";
import type { Logger } from "../logging/logger";
import { readLastFailure } from "../runtime/lastFailureStore";
import { readGlobalState, readGlobalStateForUpdate, writeGlobalState } from "../state/globalState";
import { dbCompatLevelOf, readDbCompatRecord } from "../state/dbCompatRecord";
import { classifySqliteOpenError } from "../state/kvDb";
import { resolveAdeLayout } from "../../../shared/adeLayout";
import { listDatabaseCopies, listLocalDatabases, restoreDatabaseCopies } from "./databaseCopies";
import { createStartupRecovery, type StartupRecovery, type StartupRecoveryDeps } from "./startupRecovery";
import { createStartupRecoveryWindow } from "./startupRecoveryWindow";

/**
 * The desktop's startup recovery, with this computer's real files, window,
 * clipboard and installer behind it. main.ts passes what only it has.
 *
 * Nothing here reads the disk until a failure asks for it: building it costs
 * a launch nothing.
 */
export function createDesktopStartupRecovery(args: {
  logger: Logger;
  runningVersion: string;
  globalStatePath: string;
  /** `owner/repo` of the releases. */
  releaseRepository: string;
  install: StartupRecoveryDeps["install"];
  updates: StartupRecoveryDeps["updates"];
  releaseDatabases: StartupRecoveryDeps["releaseDatabases"];
  relaunch: StartupRecoveryDeps["relaunch"];
}): StartupRecovery {
  const { logger, runningVersion, globalStatePath } = args;
  const logsFolder = resolveMachineAdeLayout().runtimeDir;
  let recovery: StartupRecovery | null = null;
  const window = createStartupRecoveryWindow({
    logger,
    getState: () => recovery!.state(),
    onAction: (action) => recovery!.handleAction(action),
  });
  recovery = createStartupRecovery({
    logger,
    runningVersion,
    platform: process.platform,
    arch: process.arch,
    // The process start: a failure record from an earlier launch is not this one's.
    launchStartedAt: Math.floor(performance.timeOrigin),
    install: args.install,
    readUpdateRecord: () => {
      const record = readGlobalState(globalStatePath).recentlyInstalledUpdate;
      if (!record || typeof record.version !== "string") return null;
      return { version: record.version, fromVersion: typeof record.fromVersion === "string" ? record.fromVersion : null };
    },
    readMachineFailure: () => readLastFailure({ kind: "machine" }),
    readProjectFailure: (projectRoot) => readLastFailure({ kind: "project", projectRoot }),
    classifyDatabaseError: (error, projectRoot) =>
      classifySqliteOpenError(error, { path: resolveAdeLayout(projectRoot).dbPath }),
    openedOnRunningVersion: (projectRoot) => {
      const dbPath = projectRoot ? resolveAdeLayout(projectRoot).dbPath : path.join(resolveMachineAdeLayout().adeDir, "ade.db");
      const record = readDbCompatRecord(dbPath);
      return record != null && record !== "unreadable" && record.lastOpenedVersion === runningVersion;
    },
    listDatabases: () => listLocalDatabases(),
    listCopies: listDatabaseCopies,
    fetchReleaseManifest: (version) => fetchReleaseManifestJson(
      `https://github.com/${args.releaseRepository}/releases/download/v${version}/${RELEASE_MANIFEST_ASSET}`,
    ),
    dbCompatLevelOf,
    updates: args.updates,
    releaseDatabases: args.releaseDatabases,
    restoreCopies: (plan) => restoreDatabaseCopies({ plan, runningVersion, logger }),
    recordWentBack: ({ fromVersion, toVersion }) => {
      // Read-modify-write that refuses a corrupt file rather than replacing it.
      const state = readGlobalStateForUpdate(globalStatePath);
      writeGlobalState(globalStatePath, {
        ...state,
        wentBackFrom: { version: fromVersion, toVersion, at: new Date().toISOString() },
      });
    },
    window,
    relaunch: args.relaunch,
    openLogsFolder: () => shell.openPath(logsFolder),
    logsFolder,
    copyText: (text) => clipboard.writeText(text),
  });
  return recovery;
}
