import path from "node:path";
import type { AppleLaneDevice } from "../../../shared/types/iosSimulator";
import { isAdeOwnedLaneDevice } from "../../../shared/types/iosSimulator";
import { parseSimctlDevices } from "./appleSimulatorCatalog";
import {
  anotherLaneHoldsUdid,
  forgetLaneDeviceRow,
  readLaneAppleDeviceRecord,
  writeAdeInstalledBundleIds,
  type LaneDeviceStore,
} from "./laneDeviceRows";
import { appleRecordingsDirectory } from "./recording/appleRecordingsStore";
import { bareSimulatorPowerOff, deleteAppleSimulator } from "./simulatorPower";

/**
 * What ending a lane does to its Apple device, on disk.
 *
 * Standalone rather than a method on the simulator service: lane archive and
 * delete run in hosts that never constructed one (the headless brain with
 * `--chat-only`, the reap-vanished-worktrees sweep), and a lane whose device
 * survived because no service happened to be alive is a simulator nobody will
 * ever delete. The cleanup pass (`registry.reconcile`) catches what this misses.
 */

type RunCommand = (
  command: string,
  args: string[],
  options?: { timeoutMs?: number },
) => Promise<{ stdout: string; stderr: string }>;

type ReleaseLogger = {
  info: (event: string, data?: Record<string, unknown>) => void;
  warn?: (event: string, data?: Record<string, unknown>) => void;
};

/** The wait between the last uninstall and the power-off; see `endLaneDeviceOnDisk`. */
const UNINSTALL_SETTLE_MS = 5_000;

/** Where `ade apple` builds and tests put DerivedData for one build root (a lane worktree). */
export function appleLaneDerivedDataPath(buildRoot: string): string {
  return path.resolve(buildRoot, ".ade", "cache", "ios-simulator", "DerivedData");
}

/**
 * Is the app on the device? `absent` only for `simctl`'s own "no such app"
 * answer (`NSPOSIXErrorDomain, code=2 … No such file or directory`); any other
 * failure is `unknown`, which callers treat as "the user may have it" so
 * nothing of theirs is ever recorded as ADE's.
 */
export async function appleAppOnDevice(run: RunCommand, udid: string, bundleId: string): Promise<"present" | "absent" | "unknown"> {
  try {
    await run("xcrun", ["simctl", "get_app_container", udid, bundleId], { timeoutMs: 30_000 });
    return "present";
  } catch (error) {
    const text = `${error instanceof Error ? error.message : String(error)} ${(error as { stderr?: unknown })?.stderr ?? ""}`;
    return /NSPOSIXErrorDomain, code=2\b|No such file or directory/u.test(text) ? "absent" : "unknown";
  }
}

/**
 * Uninstall the apps ADE put on a device.
 *
 * `simctl uninstall` needs a booted device, so one that is off is booted
 * first; with `restorePower`, it is powered off again afterwards. `remaining`
 * holds only apps certainly still there. An app whose state cannot be read
 * (the device will not boot, its runtime is gone) is logged and dropped: a
 * retry could never finish, and would boot the user's device every pass.
 * `stillFree` is asked before each step; once it says no (a lane took the
 * device again), nothing more is touched.
 */
export async function uninstallAdeApps(input: {
  udid: string;
  bundleIds: readonly string[];
  run: RunCommand;
  powerOff: (udid: string) => Promise<unknown>;
  restorePower?: boolean;
  stillFree?: () => boolean;
  logger: ReleaseLogger;
}): Promise<{ remaining: string[]; stopped: boolean }> {
  const { udid, run } = input;
  const free = () => input.stillFree?.() ?? true;
  if (!input.bundleIds.length) return { remaining: [], stopped: false };
  const state = await run("xcrun", ["simctl", "list", "devices", "--json"], { timeoutMs: 30_000 })
    .then((result) => parseSimctlDevices(result.stdout).get(udid)?.state ?? null)
    .catch(() => null);
  const wasOff = state !== "Booted";
  if (wasOff) {
    if (!free()) return { remaining: [...input.bundleIds], stopped: true };
    await run("xcrun", ["simctl", "boot", udid], { timeoutMs: 120_000 }).catch(() => undefined);
    await run("xcrun", ["simctl", "bootstatus", udid, "-b"], { timeoutMs: 180_000 }).catch(() => undefined);
  }
  const remaining: string[] = [];
  let removedAny = false;
  for (const [index, bundleId] of input.bundleIds.entries()) {
    if (!free()) return { remaining: [...remaining, ...input.bundleIds.slice(index)], stopped: true };
    await run("xcrun", ["simctl", "uninstall", udid, bundleId], { timeoutMs: 60_000 }).catch((error: unknown) => {
      input.logger.warn?.("apple.ade_app_uninstall_failed", {
        udid,
        bundleId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
    const after = await appleAppOnDevice(run, udid, bundleId);
    if (after === "absent") removedAny = true;
    else if (after === "present") remaining.push(bundleId);
    else input.logger.warn?.("apple.ade_app_state_unknown", { udid, bundleId });
  }
  /*
   * Let the uninstall settle before the power goes. Measured on iOS 26.3: a
   * `simctl shutdown` straight after `simctl uninstall` sometimes brings the
   * app back on the next boot, although `listapps` said it was gone. Five
   * seconds between the two kept it gone in every run.
   */
  if (removedAny) await new Promise((resolve) => setTimeout(resolve, UNINSTALL_SETTLE_MS));
  if (wasOff && input.restorePower && free()) await input.powerOff(udid).catch(() => undefined);
  return { remaining, stopped: false };
}

/**
 * End the lane's hold on one device, on disk.
 *
 * - An ADE device is powered off and deleted, with all its data.
 * - An attached device is the user's. It keeps everything the user put on it:
 *   ADE uninstalls only the apps it installed (their data is where the space
 *   goes). The first attempt then powers it off. A `retry` (the cleanup pass)
 *   leaves the power as it found it, and does not try again after that: an app
 *   that will not uninstall twice is logged and left.
 *
 * `powerOff` is the host's power path where there is one, so the helper and the
 * recorder hear it. `complete` is false only when an ADE device's delete
 * failed, or a first attempt left an app on the device; the caller then keeps
 * the row, so the cleanup pass tries once more.
 */
export async function endLaneDeviceOnDisk(input: {
  device: AppleLaneDevice;
  adeInstalledBundleIds: readonly string[];
  run: RunCommand;
  powerOff: (udid: string) => Promise<unknown>;
  retry?: boolean;
  logger: ReleaseLogger;
}): Promise<{ deleted: boolean; complete: boolean; remainingBundleIds: string[] }> {
  const { device, run, logger } = input;
  if (isAdeOwnedLaneDevice(device.origin)) {
    try {
      await deleteAppleSimulator(device.udid, { run, powerOff: input.powerOff });
      return { deleted: true, complete: true, remainingBundleIds: [] };
    } catch (error) {
      logger.warn?.("lane.end.apple_device_delete_failed", {
        laneId: device.laneId,
        udid: device.udid,
        error: error instanceof Error ? error.message : String(error),
      });
      return { deleted: false, complete: false, remainingBundleIds: [] };
    }
  }
  const { remaining } = await uninstallAdeApps({
    udid: device.udid,
    bundleIds: input.adeInstalledBundleIds,
    run,
    powerOff: input.powerOff,
    restorePower: input.retry === true,
    logger,
  });
  if (!input.retry) await input.powerOff(device.udid).catch(() => undefined);
  if (remaining.length) {
    logger.warn?.("lane.end.apple_ade_apps_left", { laneId: device.laneId, udid: device.udid, remaining, retry: input.retry === true });
  }
  logger.info("lane.end.apple_attached_device_released", { laneId: device.laneId, udid: device.udid, remaining });
  const complete = remaining.length === 0 || input.retry === true;
  return { deleted: false, complete, remainingBundleIds: remaining };
}

/**
 * End one lane's device row: the one place both the lane archive/delete and
 * the cleanup pass do it.
 *
 * Reads the row, lets go of the device on disk unless another lane holds the
 * same udid (then only this lane's row goes), and drops the row — or keeps it
 * with what is left when the release was incomplete, for the next pass. A
 * store read that fails counts as "maybe shared": nothing is deleted on a
 * guess.
 */
export async function endLaneDeviceRow(input: {
  store: Pick<LaneDeviceStore, "get" | "run">;
  laneId: string;
  run: RunCommand;
  powerOff: (udid: string) => Promise<unknown>;
  retry?: boolean;
  logger: ReleaseLogger;
}): Promise<{ device: AppleLaneDevice; deleted: boolean; complete: boolean } | null> {
  const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));
  let record: ReturnType<typeof readLaneAppleDeviceRecord> = null;
  let shared = true;
  try {
    record = readLaneAppleDeviceRecord(input.store, input.laneId);
    shared = record ? anotherLaneHoldsUdid(input.store, record.device.udid, input.laneId) : true;
  } catch (error) {
    input.logger.warn?.("lane.end.apple_device_read_failed", { laneId: input.laneId, error: errorText(error) });
    return null;
  }
  if (!record) return null;
  const { device } = record;
  let ended = { deleted: false, complete: true, remainingBundleIds: [] as string[] };
  if (process.platform === "darwin" && !shared) {
    ended = await endLaneDeviceOnDisk({
      device,
      adeInstalledBundleIds: record.adeInstalledBundleIds,
      run: input.run,
      powerOff: input.powerOff,
      retry: input.retry,
      logger: input.logger,
    });
  }
  try {
    if (ended.complete) forgetLaneDeviceRow(input.store, input.laneId, device.udid);
    else if (!isAdeOwnedLaneDevice(device.origin)) {
      writeAdeInstalledBundleIds(input.store, input.laneId, device.udid, ended.remainingBundleIds);
    }
  } catch (error) {
    input.logger.warn?.("lane.end.apple_device_row_update_failed", { laneId: input.laneId, error: errorText(error) });
  }
  return { device, deleted: ended.deleted, complete: ended.complete };
}

/**
 * Everything a lane that is archived or deleted owns on the Apple side.
 *
 * - The device: see `endLaneDeviceOnDisk`. On archive AND on delete; an
 *   unarchived lane gets a new device on its next ask. When another lane holds
 *   the same udid (should not happen, has happened), only this lane's row goes.
 * - The lane's build cache (`derivedDataDirectories`), deleted whole; the next
 *   build rebuilds it.
 * - Recordings only when `removeRecordings` (lane delete). An archived lane
 *   keeps its proof.
 *
 * Failures are logged, never thrown: this runs after an archive or delete has
 * happened, and aborting it would leave the lane half-gone. Fire-and-forget by
 * design — `simctl delete` can take tens of seconds on a large device set.
 */
export async function releaseLaneAppleDevice(input: {
  laneId: string;
  projectRoot: string;
  store: Pick<LaneDeviceStore, "get" | "run">;
  run: RunCommand;
  removeDirectory: (directory: string) => Promise<void>;
  /** Default true. False on archive, which keeps the lane's recordings. */
  removeRecordings?: boolean;
  /** The lane's DerivedData caches. */
  derivedDataDirectories?: string[];
  logger: ReleaseLogger & { warn: (event: string, data?: Record<string, unknown>) => void };
}): Promise<{ deletedUdid: string | null; detachedUdid: string | null; removedRecordings: boolean; removedDerivedData: number }> {
  const laneId = input.laneId.trim();
  const result = {
    deletedUdid: null as string | null,
    detachedUdid: null as string | null,
    removedRecordings: false,
    removedDerivedData: 0,
  };
  if (!laneId) return result;
  const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

  const ended = await endLaneDeviceRow({
    store: input.store,
    laneId,
    run: input.run,
    powerOff: bareSimulatorPowerOff(input.run),
    logger: input.logger,
  });
  if (ended?.deleted) result.deletedUdid = ended.device.udid;
  else if (ended && !isAdeOwnedLaneDevice(ended.device.origin)) result.detachedUdid = ended.device.udid;

  for (const directory of input.derivedDataDirectories ?? []) {
    try {
      await input.removeDirectory(directory);
      result.removedDerivedData += 1;
    } catch (error) {
      input.logger.warn("lane.end.apple_derived_data_remove_failed", { laneId, directory, error: errorText(error) });
    }
  }

  if (input.removeRecordings !== false) {
    const recordingsDir = appleRecordingsDirectory(input.projectRoot, laneId);
    try {
      await input.removeDirectory(recordingsDir);
      result.removedRecordings = true;
    } catch (error) {
      input.logger.warn("lane.end.apple_recordings_remove_failed", { laneId, recordingsDir, error: errorText(error) });
    }
  }

  if (result.deletedUdid || result.detachedUdid || result.removedRecordings || result.removedDerivedData) {
    input.logger.info("lane.end.apple_device_released", { laneId, ...result });
  }
  return result;
}
