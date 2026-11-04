import os from "node:os";
import type { AndroidLaneDevice } from "../../../shared/types/androidEmulator";
import type { Logger } from "../logging/logger";
import { runAdb } from "./adb";
import { deleteAdeAndroidAvd, readAndroidAvd, sameAvdName } from "./androidAvds";
import {
  forgetLaneAndroidDevice,
  laneHoldingAndroidAvd,
  readLaneAndroidDevice,
  writeLaneAndroidDevice,
  type AndroidLaneDeviceStore,
} from "./androidLaneDeviceStore";
import { androidDiscoveryDirs, readAndroidBootCompleted, readAndroidDiscoveryFiles } from "./androidEmulatorProcess";
import { androidAvdHome, androidSdkPaths, locateAndroidSdk, type AndroidEnv } from "./androidSdk";

/*
 * A lane giving up its AVD on disk: delete the AVD ADE made for it, or, for
 * the user's own AVD, uninstall only the packages ADE installed. Then the
 * lane's row goes.
 *
 * Needs no emulator service: lane archive and delete call it from
 * `laneService` on a host that never built one (a CLI brain with no project
 * open). It never stops an emulator. The service stops the lane's emulator
 * first; without a service, a running AVD is left as it is.
 *
 * Node built-ins and relative imports only, so it runs under `tsx`.
 */

/** The lane rows the service and the release read, as calls instead of SQL. */
export type AndroidLaneDeviceRepo = {
  get: (laneId: string) => AndroidLaneDevice | null;
  set: (device: AndroidLaneDevice) => void;
  /** Drops the row only while it still names this AVD. */
  forget: (laneId: string, avdName: string) => void;
  /** The lane holding this AVD, other than `exceptLaneId`. */
  holder: (avdName: string, exceptLaneId?: string | null) => string | null;
  /** Every row, for the start-up reconcile. Absent = no reconcile of rows. */
  list?: () => AndroidLaneDevice[];
  /**
   * Whether the lane is still a working lane of this project. Absent = every
   * lane counts as active and as this project's.
   */
  laneState?: (laneId: string) => "active" | "archived" | "missing";
};

type AndroidLaneDeviceSqlStore = AndroidLaneDeviceStore & {
  all: <T extends Record<string, unknown> = Record<string, unknown>>(sql: string, params?: Array<string | number | null>) => T[];
};

/** The `lane_android_devices` table (and the `lanes` table for lane state) as a repo. */
export function sqlAndroidLaneDeviceRepo(store: AndroidLaneDeviceSqlStore): AndroidLaneDeviceRepo {
  return {
    get: (laneId) => readLaneAndroidDevice(store, laneId),
    set: (device) => writeLaneAndroidDevice(store, device),
    forget: (laneId, avdName) => forgetLaneAndroidDevice(store, laneId, avdName),
    holder: (avdName, exceptLaneId = null) => laneHoldingAndroidAvd(store, avdName, exceptLaneId),
    list: () => store
      .all<{ lane_id: string }>("select lane_id from lane_android_devices")
      .map((row) => readLaneAndroidDevice(store, row.lane_id))
      .filter((device): device is AndroidLaneDevice => device !== null),
    laneState: (laneId) => {
      const row = store.get<{ status: string }>("select status from lanes where id = ? limit 1", [laneId]);
      if (!row) return "missing";
      return row.status === "archived" ? "archived" : "active";
    },
  };
}

export type AndroidDiskEnv = {
  /** The SDK the user picked in Settings, when any. */
  sdkSettingPath?: string | null;
  env?: AndroidEnv;
  platform?: NodeJS.Platform;
  home?: string;
  discoveryDirs?: readonly string[];
  signal?: AbortSignal;
  logger?: Pick<Logger, "info" | "warn"> | null;
};

export type AndroidDeviceEndResult = {
  /** True when nothing of the lane's is left on disk for ADE to clean up. */
  ended: boolean;
  deletedAvd: string | null;
  /** Why it is not ended, in one sentence. */
  reason: string | null;
};

const DELETE_ATTEMPTS = 4;
const DELETE_RETRY_MS = 1_000;

/**
 * Ends one lane device on disk. `anotherLaneHolds` is asked last, right before
 * the delete, so a lane that took the AVD in the meantime keeps it.
 */
export async function endAndroidLaneDeviceOnDisk(
  device: AndroidLaneDevice,
  options: AndroidDiskEnv & { deleteCreated?: boolean; anotherLaneHolds: () => boolean },
): Promise<AndroidDeviceEndResult> {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const home = options.home ?? os.homedir();
  const avdHome = androidAvdHome(env, home);
  const running = readAndroidDiscoveryFiles(options.discoveryDirs ?? androidDiscoveryDirs(platform, env, home))
    .find((emulator) => sameAvdName(emulator.avdName, device.avdName)) ?? null;

  if (device.origin === "created") {
    if (options.deleteCreated === false) return { ended: true, deletedAvd: null, reason: null };
    const avd = readAndroidAvd(avdHome, device.avdName);
    if (!avd) return { ended: true, deletedAvd: null, reason: null };
    if (!avd.adeCreated) {
      // A tool rewrote its `config.ini` and dropped ADE's marker: it reads as
      // the user's now, and the user's AVDs are never deleted.
      return { ended: true, deletedAvd: null, reason: `${device.avdName} no longer carries ADE's marker, so it was kept.` };
    }
    if (options.anotherLaneHolds()) {
      return { ended: true, deletedAvd: null, reason: `Another lane holds ${device.avdName}, so it was kept.` };
    }
    if (running) {
      return { ended: false, deletedAvd: null, reason: `${device.avdName} is running as ${running.serial}, so it was not deleted.` };
    }
    // On Windows the disks stay locked for a moment after qemu exits, so a
    // delete right after a stop is tried a few times.
    for (let attempt = 1; ; attempt += 1) {
      try {
        deleteAdeAndroidAvd(avdHome, device.avdName, []);
        break;
      } catch (error) {
        if (attempt >= DELETE_ATTEMPTS || !/in use/u.test(error instanceof Error ? error.message : "")) throw error;
        await new Promise<void>((resolve) => setTimeout(resolve, DELETE_RETRY_MS));
      }
    }
    options.logger?.info("android.lane_device.deleted", { laneId: device.laneId, avdName: device.avdName });
    return { ended: true, deletedAvd: device.avdName, reason: null };
  }

  // The user's own AVD: never deleted. Only the packages ADE installed go, and
  // only while it runs (adb needs a booted device).
  if (device.adeInstalledPackages.length === 0) return { ended: true, deletedAvd: null, reason: null };
  const located = locateAndroidSdk({ settingPath: options.sdkSettingPath, env, platform, home });
  const adbPath = located ? androidSdkPaths(located.root, platform).adb : null;
  if (!running || !adbPath || !(await readAndroidBootCompleted(adbPath, running.serial))) {
    options.logger?.warn("android.lane_device.packages_left", {
      laneId: device.laneId,
      avdName: device.avdName,
      packages: device.adeInstalledPackages,
    });
    return { ended: true, deletedAvd: null, reason: `${device.avdName} is not running, so ADE's packages were left on it.` };
  }
  for (const packageName of device.adeInstalledPackages) {
    await runAdb(adbPath, ["uninstall", packageName], {
      serial: running.serial,
      timeoutMs: 60_000,
      allowFailure: true,
      signal: options.signal,
    }).catch((error: unknown) => {
      options.logger?.warn("android.lane_device.uninstall_failed", {
        laneId: device.laneId,
        packageName,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }
  return { ended: true, deletedAvd: null, reason: null };
}

/**
 * Releases the lane's AVD: ends it on disk, then forgets the row. A created
 * AVD that is still running keeps its row, so the lane still owns it and a
 * later release can finish the job.
 */
export async function releaseAndroidLaneDevice(
  laneId: string,
  repo: AndroidLaneDeviceRepo,
  options: AndroidDiskEnv & { deleteCreated?: boolean } = {},
): Promise<{ released: boolean; deletedAvd: string | null; reason: string | null }> {
  const device = repo.get(laneId);
  if (!device) return { released: false, deletedAvd: null, reason: null };
  const result = await endAndroidLaneDeviceOnDisk(device, {
    ...options,
    anotherLaneHolds: () => repo.holder(device.avdName, laneId) !== null,
  });
  if (!result.ended) return { released: false, deletedAvd: null, reason: result.reason };
  repo.forget(laneId, device.avdName);
  return { released: true, deletedAvd: result.deletedAvd, reason: result.reason };
}
