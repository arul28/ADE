import path from "node:path";
import { clipboard, shell } from "electron";

import { resolveMachineAdeLayout } from "../../../../../ade-cli/src/services/projects/machineLayout";
import { fetchReleaseManifestJson } from "../../../../../ade-cli/src/lib/releaseAssets";
import { RELEASE_MANIFEST_ASSET } from "../../../shared/updateTrack";
import { DEFAULT_AUTO_UPDATE_PREFERENCES } from "../../../shared/types/core";
import type { Logger } from "../logging/logger";
import { readLastFailure } from "../runtime/lastFailureStore";
import { readGlobalState, readGlobalStateForUpdate, writeGlobalState } from "../state/globalState";
import { pathsEqual } from "../shared/pathCompare";
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
      // A clean open, not one "Go back" set up (`firstOpenedAt` stays null until the open).
      return record != null && record !== "unreadable"
        && record.lastOpenedVersion === runningVersion && record.firstOpenedAt != null;
    },
    findProjectDatabase: (projectRoot, databases) => {
      const dbPath = resolveAdeLayout(projectRoot).dbPath;
      return databases.find((database) => database.kind === "project" && pathsEqual(database.dbPath, dbPath)) ?? null;
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
      // Builds from before `wentBackFrom` (1.2.127, the stable at the time)
      // read only this switch: with automatic install off they download and
      // offer an update but never install it by themselves, so they cannot
      // put the broken build back unasked. A build newer than `fromVersion`
      // turns it back on (autoUpdateService).
      const state = readGlobalStateForUpdate(globalStatePath);
      // Absent means the default, which is off in 1.2.127 and since.
      const automaticInstall = state.autoUpdatePreferences?.automaticInstall === true;
      writeGlobalState(globalStatePath, {
        ...state,
        autoUpdatePreferences: {
          automaticInstall: false,
          onlyWhenIdle: state.autoUpdatePreferences?.onlyWhenIdle ?? DEFAULT_AUTO_UPDATE_PREFERENCES.onlyWhenIdle,
        },
        wentBackFrom: {
          version: fromVersion,
          toVersion,
          at: new Date().toISOString(),
          pausedAutomaticInstall: automaticInstall,
        },
      });
      logger.info("startupRecovery.automatic_install_paused", { fromVersion, toVersion, wasOn: automaticInstall });
    },
    window,
    relaunch: args.relaunch,
    openLogsFolder: () => shell.openPath(logsFolder),
    logsFolder,
    copyText: (text) => clipboard.writeText(text),
  });
  return recovery;
}
