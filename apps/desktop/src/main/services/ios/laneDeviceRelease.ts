import fs from "node:fs";
import path from "node:path";
import type { AppleLaneDevice } from "../../../shared/types/iosSimulator";
import { isAdeOwnedLaneDevice } from "../../../shared/types/iosSimulator";
import { parseSimctlDevices } from "./appleSimulatorCatalog";
import {
  anotherLaneHoldsUdid,
  forgetLaneAppleExtraDevice,
  forgetLaneDeviceRow,
  readLaneAppleDeviceRecord,
  readLaneAppleExtraDevices,
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
 * Drop package state in a lane's DerivedData that names another folder, before
 * xcodebuild reads it.
 *
 * DerivedData copied from elsewhere (a project move before moves left it out,
 * or a folder copied by hand) keeps SwiftPM's `SourcePackages/
 * workspace-state.json`, whose absolute paths name the old place. The next
 * build then fails with "There is no XCFramework found at <old path>". Only
 * that state goes (and `info.plist`, whose `WorkspacePath` names the old
 * project): the build products, the package checkouts and the artifacts stay,
 * so the build resolves again without fetching everything.
 *
 * Stale when a path in the state points into some other DerivedData's
 * `SourcePackages`, or is outside both this DerivedData and the build root and
 * no longer exists. Best effort: a read that fails changes nothing.
 */
export function healMovedDerivedData(
  derivedDataPath: string,
  buildRoot: string,
  logger?: ReleaseLogger,
): { dropped: string[] } {
  const dropped: string[] = [];
  // Compared through real paths: /tmp is /private/tmp on a Mac, and a
  // project opened through a symlink names the same folder two ways.
  const real = (value: string): string => {
    let existing = path.resolve(value);
    const rest: string[] = [];
    while (!fs.existsSync(existing) && path.dirname(existing) !== existing) {
      rest.unshift(path.basename(existing));
      existing = path.dirname(existing);
    }
    try {
      return path.join(fs.realpathSync.native(existing), ...rest);
    } catch {
      return path.resolve(value);
    }
  };
  const dd = real(derivedDataPath);
  const root = real(buildRoot);
  const inside = (candidate: string, parent: string) => {
    const relative = path.relative(parent, candidate);
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
  };
  const sourcePackages = path.join(dd, "SourcePackages");
  const statePath = path.join(sourcePackages, "workspace-state.json");
  const stalePath = (value: string): boolean => {
    if (!path.isAbsolute(value)) return false;
    const resolved = real(value);
    if (/[\\/]SourcePackages([\\/]|$)/u.test(resolved) && !inside(resolved, sourcePackages)) return true;
    if (inside(resolved, dd) || inside(resolved, root)) return false;
    return !fs.existsSync(value);
  };
  try {
    const raw = fs.readFileSync(statePath, "utf8");
    const paths: string[] = [];
    const walk = (value: unknown, key: string | null) => {
      if (typeof value === "string") {
        if (key === "path" || key === "location") paths.push(value);
        return;
      }
      if (Array.isArray(value)) {
        for (const each of value) walk(each, key);
        return;
      }
      if (value && typeof value === "object") {
        for (const [childKey, child] of Object.entries(value)) walk(child, childKey);
      }
    };
    walk(JSON.parse(raw), null);
    const stale = paths.find(stalePath);
    if (stale) {
      fs.rmSync(statePath, { force: true });
      dropped.push(statePath);
      logger?.info("ios_simulator.derived_data_package_state_dropped", { derivedDataPath: dd, stalePath: stale });
    }
  } catch {
    // No state yet, or unreadable: xcodebuild writes a fresh one.
  }
  const infoPath = path.join(dd, "info.plist");
  try {
    const info = fs.readFileSync(infoPath, "utf8");
    const workspace = /<key>WorkspacePath<\/key>\s*<string>([^<]+)<\/string>/u.exec(info)?.[1];
    if (workspace && path.isAbsolute(workspace) && !inside(real(workspace), root)) {
      fs.rmSync(infoPath, { force: true });
      dropped.push(infoPath);
      logger?.info("ios_simulator.derived_data_info_dropped", { derivedDataPath: dd, workspacePath: workspace });
    }
  } catch {
    // No info.plist (or binary and unreadable as text): nothing to drop.
  }
  return { dropped };
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
  stillFree?: () => boolean;
  retry?: boolean;
  logger: ReleaseLogger;
}): Promise<{ deleted: boolean; complete: boolean; remainingBundleIds: string[] }> {
  const { device, run, logger } = input;
  if (isAdeOwnedLaneDevice(device.origin)) {
    try {
      const deleted = await deleteAppleSimulator(device.udid, {
        run,
        powerOff: input.powerOff,
        ...(input.stillFree ? { stillFree: input.stillFree } : {}),
      });
      return { deleted, complete: true, remainingBundleIds: [] };
    } catch (error) {
      logger.warn?.("lane.end.apple_device_delete_failed", {
        laneId: device.laneId,
        udid: device.udid,
        error: error instanceof Error ? error.message : String(error),
      });
      return { deleted: false, complete: false, remainingBundleIds: [] };
    }
  }
  const { remaining, stopped } = await uninstallAdeApps({
    udid: device.udid,
    bundleIds: input.adeInstalledBundleIds,
    run,
    powerOff: input.powerOff,
    restorePower: input.retry === true,
    ...(input.stillFree ? { stillFree: input.stillFree } : {}),
    logger,
  });
  if (!input.retry && !stopped) await input.powerOff(device.udid).catch(() => undefined);
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
    const stillFree = () => {
      try {
        return !anotherLaneHoldsUdid(input.store, device.udid, input.laneId);
      } catch {
        // A failed read must not mutate a device another lane may now own.
        return false;
      }
    };
    ended = await endLaneDeviceOnDisk({
      device,
      adeInstalledBundleIds: record.adeInstalledBundleIds,
      run: input.run,
      powerOff: input.powerOff,
      stillFree,
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
 * Delete a lane's extra devices (`device-create --extra`). Each is ADE's, so
 * each is deleted whole; a row goes only once its device is gone, so a failed
 * delete is retried by the cleanup pass. A store without the table has none.
 */
export async function endLaneExtraDevices(input: {
  store: Pick<LaneDeviceStore, "all" | "run">;
  laneId: string;
  run: RunCommand;
  powerOff: (udid: string) => Promise<unknown>;
  logger: ReleaseLogger;
}): Promise<{ deleted: string[]; failed: string[] }> {
  const result = { deleted: [] as string[], failed: [] as string[] };
  let extras: AppleLaneDevice[];
  try {
    extras = readLaneAppleExtraDevices(input.store, input.laneId);
  } catch (error) {
    input.logger.warn?.("lane.end.apple_extra_device_read_failed", {
      laneId: input.laneId,
      error: error instanceof Error ? error.message : String(error),
    });
    return result;
  }
  for (const device of extras) {
    if (process.platform === "darwin") {
      try {
        await deleteAppleSimulator(device.udid, { run: input.run, powerOff: input.powerOff });
      } catch (error) {
        input.logger.warn?.("lane.end.apple_extra_device_delete_failed", {
          laneId: device.laneId,
          udid: device.udid,
          error: error instanceof Error ? error.message : String(error),
        });
        result.failed.push(device.udid);
        continue;
      }
    }
    try {
      forgetLaneAppleExtraDevice(input.store, input.laneId, device.udid);
      result.deleted.push(device.udid);
    } catch (error) {
      input.logger.warn?.("lane.end.apple_extra_device_forget_failed", {
        laneId: device.laneId,
        udid: device.udid,
        error: error instanceof Error ? error.message : String(error),
      });
      result.failed.push(device.udid);
    }
  }
  return result;
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
  /** `all` reads the lane's extra devices; a store without it has none to end. */
  store: Pick<LaneDeviceStore, "get" | "run"> & Partial<Pick<LaneDeviceStore, "all">>;
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

  const store = input.store;
  const extras = store.all
    ? await endLaneExtraDevices({
      store: { all: store.all.bind(store), run: store.run.bind(store) },
      laneId,
      run: input.run,
      powerOff: bareSimulatorPowerOff(input.run),
      logger: input.logger,
    })
    : { deleted: [], failed: [] };

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

  if (result.deletedUdid || result.detachedUdid || extras.deleted.length || extras.failed.length || result.removedRecordings || result.removedDerivedData) {
    input.logger.info("lane.end.apple_device_released", {
      laneId,
      ...result,
      ...(extras.deleted.length ? { deletedExtraUdids: extras.deleted } : {}),
      ...(extras.failed.length ? { extraDeleteFailedUdids: extras.failed } : {}),
    });
  }
  return result;
}
