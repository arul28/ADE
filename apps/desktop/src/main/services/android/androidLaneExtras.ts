import {
  ANDROID_LANE_EXTRA_DEVICE_LIMIT,
  ANDROID_LANE_EXTRA_DEVICE_MAX,
  type AndroidEmulatorError,
  type AndroidEmulatorEvent,
  type AndroidLaneDevice,
  type AndroidLaneExtraStatus,
  type AndroidPowerOffRecord,
  type AndroidRunningEmulator,
  type AndroidSdkStatus,
} from "../../../shared/types/androidEmulator";
import { androidAvdDisplayName } from "../../../shared/androidDevicePresentation";
import type { Logger } from "../logging/logger";
import { getErrorMessage } from "../shared/utils";
import { readAndroidAvd, sameAvdName } from "./androidAvds";
import type { BootedDevice } from "./androidDeviceShell";
import { AndroidEmulatorFailure } from "./androidEmulatorErrors";
import { requireBootableAvd, type AndroidEmulatorSlotHooks, type AndroidEmulatorSlots, type AndroidStartOptions } from "./androidEmulatorLifecycle";
import { ANDROID_CAME_INTO_USE } from "./androidLaneMaintenance";
import type { AndroidEmulatorStopReason } from "./androidEmulatorOwners";
import type { AdeStartedEmulators, AndroidDiscoveredEmulator, AndroidEmulatorLaunch } from "./androidEmulatorProcess";
import type { AndroidEmulatorServiceDeps } from "./androidEmulatorServiceDeps";
import type { AndroidIdleStopAnswer } from "./androidEmulatorSweep";
import { releaseAndroidLaneExtras, type AndroidLaneDeviceRepo } from "./androidLaneRelease";
import { androidSdkPaths, type AndroidEnv, type ReadyAndroidSdk } from "./androidSdk";

/*
 * A lane's EXTRA devices (`device-create --extra`), beside its own one, as
 * Apple's lanes hold extra simulators.
 *
 * Rules it keeps:
 * - An extra is an AVD ADE made. ADE deletes it with the lane, and only when
 *   its `config.ini` still carries ADE's marker.
 * - Every start of an extra goes through the memory guard, the same as the
 *   lane's device: one boot, stop and exit watch serves both
 *   (`androidEmulatorLifecycle.ts`, `slots`).
 * - An extra has no stream, recording, lease, crash pin or tests: those are
 *   the lane device's. It boots, stops, takes an install or a launch, and can
 *   become the lane device (`androidDevicePromote.ts`).
 * - Start and stop of one extra run one at a time on that extra's own queue,
 *   so a boot of an extra never holds up the lane device. A stop during a
 *   start ends the boot at once, as for the lane device.
 * - ADE stops only an extra emulator it started. Its launch is in the
 *   extras' own started-emulators file (`started-extra-emulators.json`), so a
 *   brain restart re-adopts it, and an older ADE on the same project, which
 *   reads only the project's file, never takes it for an orphan.
 *
 * Node built-ins and relative imports only, so it runs under `tsx`.
 */

/** The queue and maintenance key of one extra: the lane, then the AVD name. */
export function androidExtraKey(laneId: string, avdName: string): string {
  return `${laneId}\u0000extra:${avdName.toLowerCase()}`;
}

/** `ADE_ANDROID_LANE_EXTRA_DEVICES`: how many extras a lane may hold (default 2, at most 8). */
export function androidLaneExtraLimit(env: AndroidEnv): number {
  const raw = Number(env.ADE_ANDROID_LANE_EXTRA_DEVICES?.trim());
  if (!Number.isFinite(raw) || raw < 1) return ANDROID_LANE_EXTRA_DEVICE_LIMIT;
  return Math.min(ANDROID_LANE_EXTRA_DEVICE_MAX, Math.floor(raw));
}

/**
 * The names that call one of a lane's devices: its AVD name, the name made
 * from it (`Medium_Phone_2` is `Medium Phone 2`), and the name in its
 * `config.ini` when the AVD folder can be read. Compare with `sameAvdName`.
 */
export function androidDeviceNames(device: Pick<AndroidLaneDevice, "avdName">, avdHome: string | null): string[] {
  const shown = avdHome ? readAndroidAvd(avdHome, device.avdName)?.displayName ?? null : null;
  return [device.avdName, androidAvdDisplayName(device.avdName), ...(shown ? [shown] : [])];
}

/** True when `wanted` is one of this device's names (`androidDeviceNames`). */
export function namesAndroidDevice(device: Pick<AndroidLaneDevice, "avdName">, wanted: string, avdHome: string | null): boolean {
  return androidDeviceNames(device, avdHome).some((name) => sameAvdName(name, wanted));
}

/**
 * A call that named a device (`wanted`) and found the lane's own device acts
 * on it only while the lane still holds that device: checked in the lane's
 * queue, where a promote cannot swap it. Else `ANDROID_DEVICE_NOT_LANE_OWNED`,
 * so a device-detach never deletes an AVD the caller did not name.
 */
/** The lane's device and one of its extras both answer to `asked`. */
export function ambiguousWithLaneDevice(asked: string, own: AndroidLaneDevice, extra: AndroidLaneDevice): AndroidEmulatorFailure {
  return new AndroidEmulatorFailure(
    "ANDROID_DEVICE_NOT_LANE_OWNED",
    `${asked} is the name of this lane's device (${own.avdName}) and of an extra device (${extra.avdName}). `
      + "Name one by its AVD name: ade android devices --text lists them.",
  );
}

export function requireLaneDeviceNamed(
  repo: Pick<AndroidLaneDeviceRepo, "get">,
  laneId: string,
  wanted: string | null | undefined,
  avdHome: string | null,
): void {
  const asked = typeof wanted === "string" ? wanted.trim() : "";
  if (!asked) return;
  const own = repo.get(laneId);
  if (own && namesAndroidDevice(own, asked, avdHome)) return;
  throw new AndroidEmulatorFailure(
    "ANDROID_DEVICE_NOT_LANE_OWNED",
    `${asked} is not this lane's device any more (the lane's device changed while the call waited). ade android status --text lists the lane's devices.`,
  );
}

/** One extra's state in this process. */
type ExtraState = {
  laneId: string;
  avdName: string;
  transient: "starting" | "stopping" | null;
  error: AndroidEmulatorError | null;
  /** The emulator this process launched for it, while it runs. */
  launch: AndroidEmulatorLaunch | null;
  stopRequested: boolean;
  launchStop: Promise<void> | null;
  /** Installs and launches in flight on it. */
  jobs: number;
};

export type AndroidLaneExtrasDeps = {
  deps: Pick<AndroidEmulatorServiceDeps, "laneDevices">;
  env: AndroidEnv;
  platform: NodeJS.Platform;
  logger: Logger | null;
  /** The extras' own started-emulators file. */
  extraRegistry: AdeStartedEmulators;
  discoveryDirs: readonly string[];
  home: string;
  /** The one boot, stop, abort and exit watch (`androidEmulatorLifecycle.ts`). */
  slots: AndroidEmulatorSlots;
  emit: (event: AndroidEmulatorEvent) => void;
  runningFor: (avdName: string) => AndroidDiscoveredEmulator | null;
  asRunning: (adbPath: string | null, emulator: AndroidDiscoveredEmulator) => Promise<AndroidRunningEmulator>;
  bootedNow: (adbPath: string | null, emulator: AndroidDiscoveredEmulator) => Promise<boolean>;
  requireSdk: (needs: { emulator: boolean }) => Promise<ReadyAndroidSdk>;
  serialize: <T>(key: string, step: () => Promise<T>) => Promise<T>;
  /** Drops a queue entry of `serialize` once nothing waits on it: an extra that went. */
  forgetQueue: (key: string) => void;
  /** The AVD folder when it can be read now, else null. */
  avdHome: () => string | null;
  /** Something used the extra's emulator: the machine lifecycle's idle clock, by AVD name. */
  touch: (avdName: string) => void;
  /** The power-off record (`androidLaneMaintenance.ts`), keyed by `androidExtraKey`. */
  started: (key: string) => void;
  poweredOffRecord: (key: string) => AndroidPowerOffRecord | null;
  notePoweredOff: (key: string, record: Omit<AndroidPowerOffRecord, "at">) => void;
};

export function createAndroidLaneExtras(ctx: AndroidLaneExtrasDeps) {
  const { deps, env, platform, logger, discoveryDirs, emit, slots } = ctx;
  const repo = deps.laneDevices;
  const states = new Map<string, ExtraState>();

  const stateOf = (laneId: string, avdName: string): ExtraState => {
    const key = androidExtraKey(laneId, avdName);
    let state = states.get(key);
    if (!state) {
      state = { laneId, avdName, transient: null, error: null, launch: null, stopRequested: false, launchStop: null, jobs: 0 };
      states.set(key, state);
    }
    return state;
  };
  const peek = (laneId: string, avdName: string): ExtraState | null => states.get(androidExtraKey(laneId, avdName)) ?? null;

  const emitState = (laneId: string, avdName: string, state: AndroidLaneExtraStatus["state"] | "none") =>
    emit({ type: "android.extra.state", laneId, avdName, state });

  /** The lane holds this AVD as one of its extras now. */
  const holdsExtra = (laneId: string, avdName: string): boolean => repo.extras(laneId).some((row) => sameAvdName(row.avdName, avdName));

  /** Where an extra's boot, stop and exit are not the lane device's. */
  const hooksFor = (state: ExtraState): AndroidEmulatorSlotHooks => ({
    avdName: state.avdName,
    // Every extra is an AVD ADE made, as the lane device it may become.
    snapshot: "cold",
    registry: ctx.extraRegistry,
    emitState: (next) => emitState(state.laneId, state.avdName, next),
    logPrefix: "android.extra_",
    logFields: { extra: true },
    sentryTags: { extra: "true" },
    sentryExtra: {},
    beforeStop: async () => {},
    onExited: async () => {},
    onStoppedWhileStarting: () => emitState(state.laneId, state.avdName, "off"),
  });

  /**
   * The lane's extra that `wanted` names: its AVD name first, else the one
   * extra whose shown name (`Galaxy S25`) it is, compared without case. Null
   * when none matches. Two extras with the same shown name are refused: the
   * caller uses the AVD name.
   */
  const find = (laneId: string, wanted: string | null | undefined, avdHome: string | null): AndroidLaneDevice | null => {
    const asked = wanted?.trim();
    if (!asked) return null;
    const extras = repo.extras(laneId);
    const byName = extras.find((extra) => sameAvdName(extra.avdName, asked));
    if (byName) return byName;
    const matches = extras.filter((extra) => namesAndroidDevice(extra, asked, avdHome));
    if (matches.length > 1) {
      throw new AndroidEmulatorFailure(
        "ANDROID_DEVICE_NOT_LANE_OWNED",
        `${asked} is the name of ${matches.length} of this lane's extra devices (${matches.map((extra) => extra.avdName).join(", ")}). `
          + "Name one by its AVD name: ade android devices --text lists them.",
      );
    }
    return matches[0] ?? null;
  };

  /**
   * The extra a call's `device` names, or null for the lane's own device (no
   * `device`, or one that names it). Anything else is refused: an install or
   * a start never lands on a device the lane does not hold.
   */
  const resolveTarget = (laneId: string, wanted: string | null | undefined): AndroidLaneDevice | null => {
    const asked = typeof wanted === "string" ? wanted.trim() : "";
    if (!asked) return null;
    const avdHome = ctx.avdHome();
    const own = repo.get(laneId);
    // An exact AVD name always picks its device.
    if (own && sameAvdName(own.avdName, asked)) return null;
    const extra = find(laneId, asked, avdHome);
    if (extra && sameAvdName(extra.avdName, asked)) return extra;
    const ownByShownName = own !== null && namesAndroidDevice(own, asked, avdHome);
    // Two devices from one catalog entry share a shown name: a guess could
    // stop, or delete, the wrong one.
    if (ownByShownName && extra) throw ambiguousWithLaneDevice(asked, own!, extra);
    if (ownByShownName) return null;
    if (extra) return extra;
    throw new AndroidEmulatorFailure(
      "ANDROID_DEVICE_NOT_LANE_OWNED",
      `${asked} is neither this lane's device nor one of its extra devices. ade android status --text lists them; ade android device-create --extra adds one.`,
    );
  };

  /** The extras of a lane as `status` reads them. One discovery read per call; adb only for an unseen boot. */
  const statuses = async (laneId: string, sdk: AndroidSdkStatus): Promise<AndroidLaneExtraStatus[]> => {
    const extras = repo.extras(laneId);
    if (extras.length === 0) return [];
    const adbPath = sdk.root ? androidSdkPaths(sdk.root, platform).adb : null;
    return Promise.all(extras.map(async (device): Promise<AndroidLaneExtraStatus> => {
      const state = peek(laneId, device.avdName);
      const emulator = ctx.runningFor(device.avdName);
      const running = emulator
        ? state?.transient === "starting"
          ? { ...emulator, startedByAde: true, booted: false }
          : await ctx.asRunning(adbPath, emulator)
        : null;
      const avd = sdk.avdHome ? readAndroidAvd(sdk.avdHome, device.avdName, { running: running ? [running] : [] }) : null;
      const error = state?.error ?? null;
      const derived: AndroidLaneExtraStatus["state"] = state?.transient
        ?? (running ? (running.booted ? "booted" : "starting") : error ? "crashed" : "off");
      return {
        device,
        avd: avd ? { ...avd, running } : null,
        state: derived,
        error: derived === "crashed" || derived === "off" ? error : null,
        poweredOff: derived === "off" ? ctx.poweredOffRecord(androidExtraKey(laneId, device.avdName)) : null,
      };
    }));
  };

  /** The lane still holds this extra, else `ANDROID_DEVICE_NOT_LANE_OWNED` (a promote or a release took it). */
  const requireHeld = (laneId: string, avdName: string): void => {
    if (!holdsExtra(laneId, avdName)) {
      throw new AndroidEmulatorFailure("ANDROID_DEVICE_NOT_LANE_OWNED", `${avdName} is not one of this lane's extra devices any more.`);
    }
  };

  /** Boots one extra (no-op when it runs), through the memory guard: `force` starts it past a refusal. */
  const start = (laneId: string, extra: AndroidLaneDevice, options: AndroidStartOptions = {}): Promise<void> =>
    ctx.serialize(androidExtraKey(laneId, extra.avdName), async () => {
      // Again in the queue: a promote or a release may have taken it meanwhile.
      requireHeld(laneId, extra.avdName);
      const ready = await ctx.requireSdk({ emulator: true });
      const avd = requireBootableAvd(ready, extra.avdName, `The extra device ${extra.avdName} is no longer on this machine.`);
      ctx.touch(extra.avdName);
      if (ctx.runningFor(extra.avdName)) return;
      const state = stateOf(laneId, extra.avdName);
      await slots.reserveAndBoot(state, hooksFor(state), ready, avd, options);
      ctx.started(androidExtraKey(laneId, extra.avdName));
      emitState(laneId, extra.avdName, "booted");
    });

  /** Stops one extra if ADE started it. The caller holds the extra's queue. */
  const stopLocked = (state: ExtraState, options: { refuseForeign: boolean; reason: AndroidEmulatorStopReason }): Promise<void> =>
    slots.stop(state, hooksFor(state), options);

  /**
   * Stops one extra. A stop during its start does not wait behind the boot:
   * it ends it now. Nothing more happens (and no "off" is said) when the lane
   * does not hold it any more once the stop has its queue: a promote made it
   * the lane's device, or a release took it.
   */
  const stop = async (
    laneId: string,
    extra: AndroidLaneDevice,
    options: { refuseForeign?: boolean; reason?: AndroidEmulatorStopReason } = {},
  ): Promise<void> => {
    const key = androidExtraKey(laneId, extra.avdName);
    const state = stateOf(laneId, extra.avdName);
    await slots.interrupt(state, hooksFor(state), async () => (await ctx.requireSdk({ emulator: false }).catch(() => null))?.adbPath ?? null);
    const stopped = await ctx.serialize(key, async () => {
      if (!holdsExtra(laneId, extra.avdName)) {
        if (states.get(key) === state && !state.launch) states.delete(key);
        return false;
      }
      state.stopRequested = false;
      await stopLocked(state, { refuseForeign: options.refuseForeign !== false, reason: options.reason ?? "user" });
      state.error = null;
      return true;
    });
    if (stopped) emitState(laneId, extra.avdName, "off");
  };

  /**
   * The lane gives up one extra: its emulator stops, then the AVD is deleted
   * (`deleteCreated` false keeps it on disk as a free AVD) and the row goes.
   */
  const release = async (
    laneId: string,
    extra: AndroidLaneDevice,
    options: { deleteCreated?: boolean } = {},
  ): Promise<{ released: boolean; deletedAvd: string | null }> => {
    // Gone already (a promote, another release): nothing to do.
    if (!holdsExtra(laneId, extra.avdName)) return { released: false, deletedAvd: null };
    await stop(laneId, extra, { refuseForeign: false, reason: "released" });
    const result = await releaseAndroidLaneExtras(laneId, repo, {
      env,
      platform,
      home: ctx.home,
      discoveryDirs,
      logger,
      avdName: extra.avdName,
      ...(options.deleteCreated === undefined ? {} : { deleteCreated: options.deleteCreated }),
    });
    if (!result.released.some((name) => sameAvdName(name, extra.avdName))) {
      const reason = result.kept.find((entry) => sameAvdName(entry.avdName, extra.avdName))?.reason;
      throw new AndroidEmulatorFailure("ANDROID_AVD_RUNNING", reason ?? `${extra.avdName} could not be released.`);
    }
    const key = androidExtraKey(laneId, extra.avdName);
    states.delete(key);
    ctx.forgetQueue(key);
    logger?.info("android.extra_device_released", { laneId, avdName: extra.avdName, deleted: result.deleted.length > 0 });
    emit({ type: "android.inventory.changed" });
    emitState(laneId, extra.avdName, "none");
    return { released: true, deletedAvd: result.deleted[0] ?? null };
  };

  /**
   * A lane ended: every extra it holds stops and is released by the normal
   * rules. A failure is logged and the next extra goes on; a running extra
   * that could not stop keeps its row for the next pass.
   */
  const endLane = async (laneId: string): Promise<void> => {
    for (const extra of repo.extras(laneId)) {
      await release(laneId, extra).catch((error: unknown) => {
        logger?.warn("android.extra_device_end_failed", { laneId, avdName: extra.avdName, error: getErrorMessage(error) });
      });
    }
  };

  /** Stops every extra of a lane and keeps the rows (lane archive: the release deletes them after). */
  const stopAll = async (laneId: string): Promise<void> => {
    for (const extra of repo.extras(laneId)) {
      await stop(laneId, extra, { refuseForeign: false, reason: "lane_released" }).catch((error: unknown) => {
        logger?.warn("android.extra_device_stop_failed", { laneId, avdName: extra.avdName, error: getErrorMessage(error) });
      });
    }
  };

  /** The extra's booted emulator, or `ANDROID_NOT_RUNNING`. */
  const requireBooted = async (laneId: string, extra: AndroidLaneDevice): Promise<BootedDevice> => {
    const { adbPath } = await ctx.requireSdk({ emulator: false });
    const emulator = ctx.runningFor(extra.avdName);
    if (!emulator || peek(laneId, extra.avdName)?.transient === "starting" || !(await ctx.bootedNow(adbPath, emulator))) {
      throw new AndroidEmulatorFailure("ANDROID_NOT_RUNNING", `The extra device ${extra.avdName} is not running. Start it first: ade android start --device ${extra.avdName}`);
    }
    return { serial: emulator.serial, adbPath };
  };

  /**
   * Runs an install or a launch on one extra: boots it first when it is off
   * (through the memory guard, no `force`), and counts it as in use
   * meanwhile, so a promote, a release or the idle stop does not take it
   * away. The count starts before the first await.
   */
  const runJob = async <T>(
    laneId: string,
    extra: AndroidLaneDevice,
    job: (booted: () => Promise<BootedDevice>) => Promise<T>,
    options: Pick<AndroidStartOptions, "chatSessionId"> = {},
  ): Promise<T> => {
    const state = stateOf(laneId, extra.avdName);
    state.jobs += 1;
    ctx.touch(extra.avdName);
    try {
      if (!ctx.runningFor(extra.avdName) || state.transient === "starting") await start(laneId, extra, options);
      return await job(() => requireBooted(laneId, extra));
    } finally {
      state.jobs -= 1;
      ctx.touch(extra.avdName);
    }
  };

  /**
   * ADE powers one idle extra off by itself, in the extra's queue: `idle`
   * (the machine sweep) or `cleanup` (`device-cleanup --power-off-idle`).
   * `check` runs there, just before the stop, and its answer (the extra came
   * into use, or was pinned) leaves it running. `not_found` when it is not an
   * extra of this lane any more.
   */
  const powerOff = async (
    laneId: string,
    extra: AndroidLaneDevice,
    reason: "idle" | "cleanup",
    check: () => Promise<AndroidIdleStopAnswer | null>,
  ): Promise<AndroidIdleStopAnswer> => {
    const answer = await ctx.serialize(androidExtraKey(laneId, extra.avdName), async (): Promise<AndroidIdleStopAnswer> => {
      if (!holdsExtra(laneId, extra.avdName)) return "not_found";
      const early = await check();
      if (early) return early;
      const state = stateOf(laneId, extra.avdName);
      await stopLocked(state, { refuseForeign: false, reason });
      state.error = null;
      return "stopped";
    });
    if (answer === "stopped") emitState(laneId, extra.avdName, "off");
    return answer;
  };

  /** The machine sweep's idle stop of one extra (`androidEmulatorUse.ts`): its status says so until its next start. */
  const stopIdle = async (
    laneId: string,
    extra: AndroidLaneDevice,
    idleMinutes: number,
    check: () => Promise<AndroidIdleStopAnswer | null>,
  ): Promise<AndroidIdleStopAnswer> => {
    const answer = await powerOff(laneId, extra, "idle", check);
    if (answer === "stopped") {
      ctx.notePoweredOff(androidExtraKey(laneId, extra.avdName), { reason: "idle", idleMinutes });
      emit({ type: "android.inventory.changed" });
    }
    return answer;
  };

  /** The cleanup pass's power-off of one extra. `stillIdle` is asked in the extra's queue; false throws, as for the lane device. */
  const powerOffIdle = async (laneId: string, extra: AndroidLaneDevice, stillIdle: () => boolean): Promise<boolean> =>
    (await powerOff(laneId, extra, "cleanup", async () => {
      if (!stillIdle()) throw new Error(ANDROID_CAME_INTO_USE);
      return null;
    })) === "stopped";

  /** What the extra is busy with, as a phrase, or null. */
  const busyReason = (laneId: string, avdName: string): string | null => {
    const state = peek(laneId, avdName);
    if (!state) return null;
    if (state.transient === "starting") return "starting";
    if (state.transient === "stopping") return "stopping";
    if (state.jobs > 0) return "installing or launching an app";
    return null;
  };

  /** Promote: the extra's launch (when this process made it) moves to the lane state, and its state goes. */
  const takeLaunch = (laneId: string, avdName: string): AndroidEmulatorLaunch | null => {
    const key = androidExtraKey(laneId, avdName);
    const state = states.get(key) ?? null;
    const launch = state?.launch ?? null;
    // The old state's exit watch must not read the lane device's exit as an extra's crash.
    if (state) state.launch = null;
    states.delete(key);
    ctx.forgetQueue(key);
    return launch;
  };

  /** Promote: the lane's old device, now an extra, keeps its running emulator and the watch on it. */
  const adoptLaunch = (laneId: string, avdName: string, launch: AndroidEmulatorLaunch | null): void => {
    const state = stateOf(laneId, avdName);
    state.error = null;
    state.launch = launch;
    if (launch) slots.watchExit(state, hooksFor(state), launch);
  };

  return {
    find,
    resolveTarget,
    holdsExtra,
    requireHeld,
    statuses,
    start,
    stop,
    release,
    endLane,
    stopAll,
    requireBooted,
    runJob,
    stopIdle,
    powerOffIdle,
    busyReason,
    takeLaunch,
    adoptLaunch,
    /** The extras' emulators this process launched (the owned check and the dispose stop). */
    launches: (): AndroidEmulatorLaunch[] => [...states.values()].flatMap((state) => (state.launch ? [state.launch] : [])),
    /** Ends every extra boot in progress (the service's dispose). */
    async abortAll(adbPath: string): Promise<void> {
      await Promise.all([...states.values()].filter((state) => state.transient === "starting" && state.launch)
        .map((state) => slots.abort(state, hooksFor(state), async () => adbPath)));
    },
    clear: (): void => states.clear(),
  };
}

export type AndroidLaneExtras = ReturnType<typeof createAndroidLaneExtras>;
