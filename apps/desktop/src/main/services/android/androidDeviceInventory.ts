import type {
  AndroidAvdListing,
  AndroidCreateDeviceArgs,
  AndroidDeviceInventory,
  AndroidEmulatorError,
  AndroidEmulatorEvent,
  AndroidEmulatorServiceApi,
  AndroidLaneDevice,
  AndroidLaneDeviceStatus,
  AndroidRunningEmulator,
  AndroidSdkStatus,
  AndroidSystemImage,
} from "../../../shared/types/androidEmulator";
import { androidCatalogColor, androidCatalogEntry, type AndroidCatalogEntry } from "../../../shared/androidDeviceCatalog";
import type { Logger } from "../logging/logger";
import { getErrorMessage } from "../shared/utils";
import {
  createAndroidAvd,
  deleteAdeAndroidAvd,
  listAndroidAvds,
  measureAndroidAvdBytes,
  pickAndroidSystemImage,
  readAdeAvdLaneId,
  readAndroidAvd,
  sameAvdName,
  setAndroidAvdColor,
} from "./androidAvds";
import { resolveAndroidCatalogDefinition, writeAndroidAdeProfile } from "./androidCatalogProfiles";
import { AndroidEmulatorFailure, requireLaneId } from "./androidEmulatorErrors";
import type { AndroidDiscoveredEmulator } from "./androidEmulatorProcess";
import { listAndroidDeviceDefinitions } from "./androidHardwareProfiles";
import { releaseAndroidLaneDevice, type AndroidLaneDeviceRepo } from "./androidLaneRelease";
import { androidSdkPaths, androidUserHome, listAndroidSystemImages, type AndroidEnv, type ReadyAndroidSdk } from "./androidSdk";
import { pickWorkCopyAvd } from "./androidWorkCopy";

/*
 * The lane's AVD: the inventory, and making, attaching, releasing, deleting
 * and colouring a device. A lane holds at most one AVD, and an AVD belongs to
 * at most one lane. The emulator's boot and stop stay in the service
 * (`androidEmulatorService.ts`); this file reaches them through `startLocked`
 * and `stopLocked`.
 *
 * Node built-ins and relative imports only, so it runs under `tsx`.
 */

/** The profile a chat's work copy gets when no AVD here is free. */
const WORK_COPY_PROFILE_ID = "medium_phone";

/** Refuses a colour the catalog device does not come in, and names the ones it does. */
function assertCatalogColor(entry: AndroidCatalogEntry, colorId: string): void {
  if (!entry.colors.some((color) => color.id === colorId)) {
    throw new Error(`${entry.name} has no colour ${colorId}. Colours: ${entry.colors.map((color) => color.id).join(", ")}.`);
  }
}

/** The part of the service's lane state this file reads and writes. */
export type AndroidInventoryLaneState = {
  /** The last start that failed or the emulator that died; cleared by a release. */
  error: AndroidEmulatorError | null;
};

export type AndroidDeviceInventoryDeps<S extends AndroidInventoryLaneState> = {
  laneDevices: AndroidLaneDeviceRepo;
  readSdk: () => Promise<AndroidSdkStatus>;
  requireSdk: (needs: { emulator: boolean }) => Promise<ReadyAndroidSdk>;
  platform: NodeJS.Platform;
  env: AndroidEnv;
  home: string;
  discoveryDirs: readonly string[];
  logger: Logger | null;
  now: () => Date;
  emit: (event: AndroidEmulatorEvent) => void;
  assertLive: () => void;
  assertWorkCopyLive: (laneId: string) => void;
  laneLiveness: (laneId: string) => "active" | "archived" | "missing" | null;
  /** Runs one lifecycle step after every earlier step on the key has settled. */
  serialize: <T>(key: string, step: () => Promise<T>) => Promise<T>;
  laneState: (laneId: string) => S;
  /** The lane's state is dropped (its device is gone). */
  forgetLane: (laneId: string) => void;
  /** Boots the lane's device. The caller holds the lane's queue. */
  startLocked: (state: S) => Promise<AndroidLaneDeviceStatus>;
  /** Stops the lane's emulator if ADE started it. The caller holds the lane's queue. */
  stopLocked: (state: S, device: AndroidLaneDevice, options: { refuseForeign: boolean }) => Promise<void>;
  emitDeviceState: (laneId: string) => Promise<AndroidLaneDeviceStatus>;
  discovered: () => AndroidDiscoveredEmulator[];
  ownsEmulator: (emulator: AndroidDiscoveredEmulator) => boolean;
  asRunning: (adbPath: string | null, emulator: AndroidDiscoveredEmulator) => Promise<AndroidRunningEmulator>;
  runningFor: (avdName: string) => AndroidDiscoveredEmulator | null;
  /** While the emulator still runs: the packages ADE put on an attached AVD come off. */
  beforeRelease: (laneId: string) => Promise<void>;
};

export function createAndroidDeviceInventory<S extends AndroidInventoryLaneState>(deps: AndroidDeviceInventoryDeps<S>) {
  const { laneDevices, requireSdk, platform, env, home, logger, emit, serialize } = deps;

  const assertLaneFree = (laneId: string, avdName: string | null) => {
    const held = laneDevices.get(laneId);
    if (held && !(avdName && sameAvdName(held.avdName, avdName))) {
      throw new AndroidEmulatorFailure(
        "ANDROID_LANE_HAS_DEVICE",
        `This lane already has ${held.avdName}. Release it before adding another device.`,
      );
    }
  };

  const assertNotHeldElsewhere = (laneId: string | null, avdName: string) => {
    const holder = laneDevices.holder(avdName, laneId);
    if (holder) {
      throw new AndroidEmulatorFailure("ANDROID_AVD_HELD_BY_OTHER_LANE", `${avdName} belongs to another lane (${holder}).`);
    }
  };

  const definitionsFor = (root: string, images: readonly AndroidSystemImage[]) =>
    listAndroidDeviceDefinitions({
      sdkRoot: root,
      systemImageDirs: images.map((image) => image.path),
      platform,
      env,
      home,
      onUnreadable: (filePath, error) => logger?.warn("android.profile_file_unreadable", { filePath, error: getErrorMessage(error) }),
    });

  /** A new row for the lane's AVD. */
  const newLaneDevice = (
    laneId: string,
    avdName: string,
    origin: AndroidLaneDevice["origin"],
    profileId: string | null,
    systemImage: string | null,
  ): AndroidLaneDevice => ({ laneId, avdName, origin, profileId, systemImage, createdAt: deps.now().toISOString(), adeInstalledPackages: [] });

  /** How the lane release reads this machine's disks. */
  const releaseOptions = (deleteCreated?: boolean) => ({
    env,
    platform,
    home,
    discoveryDirs: deps.discoveryDirs,
    logger,
    ...(deleteCreated === undefined ? {} : { deleteCreated }),
  });

  /**
   * Makes a new AVD for the lane and records it as the lane's own (deleted
   * with the lane). The caller holds the lane's queue and checked the lane
   * is free.
   */
  const createLocked = async (
    laneId: string,
    profileId: string,
    wanted: string | null,
    displayName: string | null,
    // P1 look: a brand catalog entry picks the profile and records its colour.
    look: { entry: AndroidCatalogEntry; colorId: string } | null = null,
  ): Promise<void> => {
    const ready = await requireSdk({ emulator: true });
    const images = listAndroidSystemImages(ready.root);
    const definitions = definitionsFor(ready.root, images);
    if (definitions.length === 0) {
      // The profiles come from the SDK's Command-line Tools (or Android
      // Studio). An SDK made of zips has neither, and then nothing can be made.
      throw new AndroidEmulatorFailure(
        "ANDROID_TOOL_MISSING",
        "This machine's Android SDK has no hardware profiles, so ADE cannot make a device. Install the Android SDK Command-line Tools (`sdkmanager \"cmdline-tools;latest\"`, or Android Studio's SDK Manager), then try again. `device-attach` still works with an AVD you already have.",
      );
    }
    const catalogChoice = look ? resolveAndroidCatalogDefinition(look.entry, definitions) : null;
    if (look && !catalogChoice) {
      throw new AndroidEmulatorFailure(
        "ANDROID_AVD_NOT_FOUND",
        `This SDK has no hardware profile for ${look.entry.name} (tried ${look.entry.sdkProfileIds.join(", ")}). Update the Android SDK Command-line Tools, then try again.`,
      );
    }
    if (look?.entry.adeProfile) {
      // Best effort: the AVD is made from the in-memory profile either way.
      const skipped = writeAndroidAdeProfile(androidUserHome(env, home), look.entry.adeProfile);
      if (skipped) logger?.warn("android.ade_profile_not_written", { profileId: look.entry.adeProfile.id, reason: skipped });
    }
    const definition = catalogChoice?.definition ?? definitions.find((entry) => entry.profile.id === profileId);
    if (!definition) {
      throw new AndroidEmulatorFailure("ANDROID_AVD_NOT_FOUND", `No hardware profile named ${profileId} is on this machine.`);
    }
    const image = wanted
      ? images.find((entry) => entry.packageId === wanted) ?? null
      : pickAndroidSystemImage(images, ready.sdk.hostAbi, definition);
    if (!image) {
      throw new AndroidEmulatorFailure(
        "ANDROID_NO_SYSTEM_IMAGE",
        wanted
          ? `The system image ${wanted} is not installed.`
          : `No ${ready.sdk.hostAbi} system image is installed. Install one with the SDK Manager.`,
      );
    }
    const avd = createAndroidAvd({
      sdkRoot: ready.root,
      avdHome: ready.avdHome,
      userHome: androidUserHome(env, home),
      laneId,
      definition,
      image,
      displayName: displayName ?? look?.entry.name ?? null,
      catalogId: look?.entry.id ?? null,
      colorId: look?.colorId ?? null,
    });
    laneDevices.set(newLaneDevice(laneId, avd.name, "created", definition.profile.id, image.packageId));
    logger?.info("android.device_created", {
      laneId,
      avdName: avd.name,
      profileId: definition.profile.id,
      systemImage: image.packageId,
      ...(look ? { catalogId: look.entry.id, colorId: look.colorId, profileFallback: catalogChoice?.fallback ?? false } : {}),
    });
    emit({ type: "android.inventory.changed" });
  };

  const api: Pick<
    AndroidEmulatorServiceApi,
    "listDevices" | "createDevice" | "attachDevice" | "releaseDevice" | "deleteDevice" | "setDeviceColor"
  > = {
    async listDevices(args) {
      const sdk = await deps.readSdk();
      if (!sdk.found || !sdk.root || !sdk.avdHome) return { avds: [], profiles: [], images: [] };
      const adbPath = androidSdkPaths(sdk.root, platform).adb;
      const running = await Promise.all(deps.discovered().map((emulator) => deps.asRunning(adbPath, emulator)));
      const avds: AndroidAvdListing[] = listAndroidAvds(sdk.avdHome, { running }).map((avd) => {
        const madeFor = avd.adeCreated ? readAdeAvdLaneId(avd) : null;
        return {
          ...avd,
          running: running.find((emulator) => sameAvdName(emulator.avdName, avd.name)) ?? null,
          heldByLaneId: laneDevices.holder(avd.name),
          madeForOtherLane: madeFor !== null && deps.laneLiveness(madeFor) === "missing",
        };
      });
      // Storage: sizes only when asked (the picker's Storage section), never on every read.
      if (args?.measureSizes === true) {
        await Promise.all(avds.map(async (avd) => { avd.sizeBytes = await measureAndroidAvdBytes(avd.path); }));
      }
      const images = listAndroidSystemImages(sdk.root);
      const profiles = definitionsFor(sdk.root, images).map((definition) => definition.profile);
      const inventory: AndroidDeviceInventory = { avds, profiles, images };
      return inventory;
    },

    createDevice(args: AndroidCreateDeviceArgs) {
      deps.assertLive();
      const laneId = requireLaneId(args.laneId);
      const profileId = typeof args.profileId === "string" ? args.profileId.trim() : "";
      const catalogId = typeof args.catalogId === "string" ? args.catalogId.trim() : "";
      const entry = catalogId ? androidCatalogEntry(catalogId) : null;
      if (catalogId && !entry) throw new Error(`No catalog device named ${catalogId}.`);
      if (!profileId && !entry) throw new Error("profileId or catalogId is required.");
      const colorId = typeof args.colorId === "string" ? args.colorId.trim() : "";
      if (entry && colorId) assertCatalogColor(entry, colorId);
      const look = entry ? { entry, colorId: androidCatalogColor(entry, colorId || null).id } : null;
      return serialize(laneId, async () => {
        deps.assertWorkCopyLive(laneId);
        assertLaneFree(laneId, null);
        await createLocked(laneId, profileId, args.systemImage?.trim() || null, args.displayName ?? null, look);
        if (args.start === false) return deps.emitDeviceState(laneId);
        return deps.startLocked(deps.laneState(laneId));
      });
    },

    attachDevice(args) {
      deps.assertLive();
      const laneId = requireLaneId(args.laneId);
      const avdName = typeof args.avdName === "string" ? args.avdName.trim() : "";
      if (!avdName) throw new Error("avdName is required.");
      return serialize(laneId, async () => {
        deps.assertWorkCopyLive(laneId);
        assertLaneFree(laneId, avdName);
        assertNotHeldElsewhere(laneId, avdName);
        const ready = await requireSdk({ emulator: false });
        const avd = readAndroidAvd(ready.avdHome, avdName);
        if (!avd) throw new AndroidEmulatorFailure("ANDROID_AVD_NOT_FOUND", `No AVD named ${avdName} is on this machine.`);
        if (!laneDevices.get(laneId)) {
          // Again after the await: another lane's queue may have taken it meanwhile.
          // No await from here to the row write.
          assertNotHeldElsewhere(laneId, avdName);
          // Only the lane an AVD was made for deletes it with the lane. An
          // ADE AVD made for another lane may belong to a lane of another
          // project (this lane table cannot see it), so it is attached:
          // never deleted on release, like the user's own AVDs.
          const origin = avd.adeCreated && readAdeAvdLaneId(avd) === laneId ? "created" : "attached";
          laneDevices.set(newLaneDevice(laneId, avd.name, origin, avd.profileId, null));
          emit({ type: "android.inventory.changed" });
        }
        if (args.start === false) return deps.emitDeviceState(laneId);
        return deps.startLocked(deps.laneState(laneId));
      });
    },

    releaseDevice(args) {
      const laneId = requireLaneId(args.laneId);
      return serialize(laneId, async () => {
        const state = deps.laneState(laneId);
        const device = laneDevices.get(laneId);
        if (!device) return { released: false, deletedAvd: null };
        await deps.beforeRelease(laneId);
        await deps.stopLocked(state, device, { refuseForeign: false });
        const result = await releaseAndroidLaneDevice(laneId, laneDevices, releaseOptions(args.deleteCreated !== false));
        if (!result.released) {
          throw new AndroidEmulatorFailure("ANDROID_AVD_RUNNING", result.reason ?? `${device.avdName} could not be released.`);
        }
        state.error = null;
        emit({ type: "android.inventory.changed" });
        emit({ type: "android.device.state", laneId, state: "none" });
        return { released: true, deletedAvd: result.deletedAvd };
      });
    },

    deleteDevice(args) {
      deps.assertLive();
      const avdName = typeof args.avdName === "string" ? args.avdName.trim() : "";
      if (!avdName) throw new Error("avdName is required.");
      return serialize(`avd:${avdName.toLowerCase()}`, async () => {
        assertNotHeldElsewhere(null, avdName);
        const ready = await requireSdk({ emulator: false });
        const running = deps.runningFor(avdName);
        if (running) throw new AndroidEmulatorFailure("ANDROID_AVD_RUNNING", `${avdName} is running. Stop it before deleting it.`);
        // Again after the await: a lane may have attached it meanwhile.
        assertNotHeldElsewhere(null, avdName);
        deleteAdeAndroidAvd(ready.avdHome, avdName, []);
        logger?.info("android.device_deleted", { avdName });
        emit({ type: "android.inventory.changed" });
        return { deleted: true };
      });
    },

    /* P1 look: the body colour. */
    setDeviceColor(args) {
      deps.assertLive();
      const laneId = requireLaneId(args.laneId);
      const colorId = typeof args.colorId === "string" ? args.colorId.trim() : "";
      if (!colorId) throw new Error("colorId is required.");
      return serialize(laneId, async () => {
        const device = laneDevices.get(laneId);
        if (!device) throw new AndroidEmulatorFailure("ANDROID_NOT_RUNNING", "This lane has no Android device.");
        const ready = await requireSdk({ emulator: false });
        const avd = readAndroidAvd(ready.avdHome, device.avdName);
        if (!avd) throw new AndroidEmulatorFailure("ANDROID_AVD_NOT_FOUND", `No AVD named ${device.avdName} is on this machine.`);
        const entry = androidCatalogEntry(avd.catalogId ?? null);
        if (!entry) throw new Error(`${device.avdName} was not made from a catalog device, so it has no colours.`);
        assertCatalogColor(entry, colorId);
        setAndroidAvdColor(avd, colorId);
        emit({ type: "android.inventory.changed" });
        return deps.emitDeviceState(laneId);
      });
    },
  };

  return {
    api,

    /**
     * A chat's work copy gets its first device: a free AVD this machine already
     * has before a new one, since a new one costs gigabytes and a first boot.
     * The borrowed AVD is attached, so releasing it never deletes it. The caller
     * holds the lane's queue.
     */
    async ensureWorkCopyDeviceLocked(laneId: string): Promise<void> {
      const ready = await requireSdk({ emulator: true });
      // No await from here to the row write: two lanes asking at once cannot
      // both take one AVD.
      const borrowed = pickWorkCopyAvd(listAndroidAvds(ready.avdHome), deps.discovered(), { ...laneDevices, owns: deps.ownsEmulator });
      if (borrowed) {
        laneDevices.set(newLaneDevice(laneId, borrowed.name, "attached", borrowed.profileId, null));
        logger?.info("android.work_copy_borrowed", { laneId, avdName: borrowed.name, adeCreated: borrowed.adeCreated });
        emit({ type: "android.inventory.changed" });
        return;
      }
      await createLocked(laneId, WORK_COPY_PROFILE_ID, null, null);
    },

    /**
     * Stops the lane's emulator and releases its AVD by the normal rules (an
     * attached AVD stays). The caller holds the lane's queue.
     */
    async endLaneLocked(device: AndroidLaneDevice) {
      await deps.beforeRelease(device.laneId);
      await deps.stopLocked(deps.laneState(device.laneId), device, { refuseForeign: false });
      const result = await releaseAndroidLaneDevice(device.laneId, laneDevices, releaseOptions());
      deps.forgetLane(device.laneId);
      return result;
    },
  };
}
