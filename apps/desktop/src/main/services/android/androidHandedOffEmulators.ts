import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveAdeLayout } from "../../../shared/adeLayout";
import type { AndroidLaneDevice } from "../../../shared/types/androidEmulator";
import type { Logger } from "../logging/logger";
import { getErrorMessage } from "../shared/utils";
import {
  AdeStartedEmulators,
  androidDiscoveryDirs,
  readAndroidDiscoveryFiles,
  stopAndroidEmulator,
  type AndroidDiscoveredEmulator,
} from "./androidEmulatorProcess";
import { readAndroidSdkStatus, requireAndroidSdkTools, type AndroidEnv } from "./androidSdk";
import type { AndroidLaneDeviceRepo } from "./androidLaneRelease";

/*
 * The emulators ADE started and handed off: the started-emulators state file
 * in a service's data folder, and the stops that read it. A brain that exits
 * leaves its emulators running (`handOffOnDispose`); the next service adopts
 * them from this file, and a project's removal stops them through it.
 *
 * Node built-ins and relative imports only, so it runs under `tsx`.
 */

/** The started-emulators state file in a service's data folder, warning once per kind of file failure. */
export function openStartedEmulators(dataDir: string, logger: Logger | null): AdeStartedEmulators {
  const warned = new Set<string>();
  const file = path.join(dataDir, "started-emulators.json");
  return new AdeStartedEmulators(file, (op, error) => {
    const code = (error as NodeJS.ErrnoException)?.code ?? "parse";
    if (warned.has(`${op}:${code}`)) return;
    warned.add(`${op}:${code}`);
    logger?.warn("android.started_emulators_file_failed", { op, file, error: getErrorMessage(error) });
  });
}

/**
 * A service's start-up reconcile. A lane archived or deleted while no brain
 * ran (or a chat's work copy deleted then) left its row (the release keeps a
 * running AVD's row) and maybe its emulator: stop that emulator and release
 * the AVD by the normal rules. Then an emulator ADE started that no lane
 * holds at all is stopped. Lanes that are still active keep their emulators:
 * those are re-adopted. True when something changed.
 */
export async function reconcileStartedEmulators(args: {
  laneDevices: AndroidLaneDeviceRepo;
  laneLiveness: (laneId: string) => "active" | "archived" | "missing" | null;
  /** Running emulators the state file lists as ADE's. */
  startedHere: () => AndroidDiscoveredEmulator[];
  /** Runs before the SDK is read: the emulators started before the owner file are taken in. */
  takeIn: () => void;
  /** The SDK's adb, or null without an SDK. */
  locateAdb: () => string | null;
  isDisposed: () => boolean;
  serialize: <T>(laneId: string, step: () => Promise<T>) => Promise<T>;
  endLaneLocked: (device: AndroidLaneDevice) => Promise<object>;
  /** Releases the extras of an ended lane that holds no device of its own. The caller holds the lane's queue. */
  endExtrasLocked: (laneId: string) => Promise<void>;
  stopOrphan: (emulator: AndroidDiscoveredEmulator, adbPath: string) => Promise<unknown>;
  logger: Logger | null;
}): Promise<boolean> {
  const { logger } = args;
  // Cheap reads first (the lane rows, the discovery files, the state file):
  // a brain start with nothing to reconcile never reads the SDK, which would
  // run `emulator -accel-check` once per project.
  // A chat's work copy counts as a lane while the copy exists.
  const ended = (laneId: string) => {
    const liveness = args.laneLiveness(laneId);
    return liveness !== null && liveness !== "active";
  };
  const endedLanes = (args.laneDevices.list?.() ?? []).filter((device) => ended(device.laneId));
  // A lane that ended with extras and no device of its own (`endLaneLocked` releases the others' extras).
  const endedExtraLanes = [...new Set(args.laneDevices.extras(null).map((extra) => extra.laneId))]
    .filter((laneId) => ended(laneId) && !endedLanes.some((device) => device.laneId === laneId));
  // `holder` reads both tables, so a running extra is never an orphan.
  const orphans = () => args.startedHere().filter((emulator) => args.laneDevices.holder(emulator.avdName) === null);
  args.takeIn();
  if (endedLanes.length === 0 && endedExtraLanes.length === 0 && orphans().length === 0) return false;
  const adbPath = args.locateAdb();
  if (!adbPath || args.isDisposed()) return false;
  let changed = false;
  for (const device of endedLanes) {
    await args.serialize(device.laneId, async () => {
      const result = await args.endLaneLocked(device);
      changed = true;
      logger?.info("android.reconcile.released", { laneId: device.laneId, avdName: device.avdName, ...result });
    }).catch((error: unknown) => {
      logger?.warn("android.reconcile.release_failed", { laneId: device.laneId, error: getErrorMessage(error) });
    });
  }
  for (const laneId of endedExtraLanes) {
    await args.serialize(laneId, async () => {
      await args.endExtrasLocked(laneId);
      changed = true;
      logger?.info("android.reconcile.released_extras", { laneId });
    }).catch((error: unknown) => {
      logger?.warn("android.reconcile.release_failed", { laneId, error: getErrorMessage(error) });
    });
  }
  for (const emulator of orphans()) {
    if (args.isDisposed()) return changed;
    await args.stopOrphan(emulator, adbPath).then(
      () => {
        changed = true;
        logger?.info("android.reconcile.stopped_orphan", { serial: emulator.serial, avdName: emulator.avdName });
      },
      (error: unknown) => logger?.warn("android.reconcile.stop_failed", { serial: emulator.serial, error: getErrorMessage(error) }),
    );
  }
  return changed;
}

/**
 * Stops every running emulator the state file lists as ADE's, and nothing
 * else; each stop forgets its emulator in the file. A failed stop is logged
 * and the rest still run.
 */
export async function stopAdeStartedEmulators(args: {
  registry: AdeStartedEmulators;
  adbPath: string;
  discoveryDirs: readonly string[];
  logger: Logger | null;
  /** The launcher process this run kept for an emulator, if any. */
  launcherPidFor?: (emulator: AndroidDiscoveredEmulator) => number | null;
  /** One emulator stopped (the machine's owner record goes with it). */
  onStopped?: (emulator: AndroidDiscoveredEmulator) => void;
}): Promise<void> {
  for (const emulator of readAndroidDiscoveryFiles(args.discoveryDirs)) {
    if (!args.registry.owns(emulator)) continue;
    await stopAndroidEmulator({
      adbPath: args.adbPath,
      serial: emulator.serial,
      consolePort: emulator.consolePort,
      avdName: emulator.avdName,
      pid: emulator.pid,
      launcherPid: args.launcherPidFor?.(emulator) ?? null,
      registry: args.registry,
      discoveryDirs: args.discoveryDirs,
    }).then(() => args.onStopped?.(emulator), (error: unknown) => {
      args.logger?.warn("android.dispose_stop_failed", { serial: emulator.serial, error: getErrorMessage(error) });
    });
  }
}

/**
 * Stops the emulators a project's service handed off, once the project is
 * removed from this machine and no next service will re-adopt them.
 *
 * The brain calls it when a removal joined a teardown that had already handed
 * the devices off (a repair's `"close"` drain). It reads the same state file
 * the project's service uses (`<project>/.ade/android`), stops only the
 * emulators listed there, and does nothing without an SDK or a state file.
 * It never throws.
 */
export async function stopHandedOffAndroidEmulators(args: {
  projectRoot: string;
  logger?: Logger | null;
  env?: AndroidEnv;
  platform?: NodeJS.Platform;
  home?: string;
}): Promise<void> {
  const logger = args.logger ?? null;
  try {
    const platform = args.platform ?? process.platform;
    if (platform !== "darwin" && platform !== "win32" && platform !== "linux") return;
    const dataDir = path.join(resolveAdeLayout(args.projectRoot).adeDir, "android");
    if (!fs.existsSync(path.join(dataDir, "started-emulators.json"))) return;
    const env = args.env ?? process.env;
    const home = args.home ?? os.homedir();
    const sdk = await readAndroidSdkStatus({ settingPath: null, env, platform, home });
    let adbPath: string;
    try {
      adbPath = requireAndroidSdkTools(sdk, platform, { emulator: false }).adbPath;
    } catch {
      // No SDK or no adb: nothing ADE could have started is reachable here.
      return;
    }
    await stopAdeStartedEmulators({
      registry: openStartedEmulators(dataDir, logger),
      adbPath,
      discoveryDirs: androidDiscoveryDirs(platform, env, home),
      logger,
    });
  } catch (error) {
    logger?.warn("android.unregister_stop_failed", { projectRoot: args.projectRoot, error: getErrorMessage(error) });
  }
}
