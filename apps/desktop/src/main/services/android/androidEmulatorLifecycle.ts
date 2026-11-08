import fs from "node:fs";
import path from "node:path";
import type {
  AndroidAvd,
  AndroidEmulatorEvent,
  AndroidLaneDevice,
  AndroidLaneDeviceStatus,
  AndroidSdkStatus,
} from "../../../shared/types/androidEmulator";
import { androidAvdDisplayName } from "../../../shared/androidDevicePresentation";
import { captureError } from "../../../shared/sentry/capture";
import type { Logger } from "../logging/logger";
import { getErrorMessage } from "../shared/utils";
import { readAndroidAvd } from "./androidAvds";
import type { createAndroidCrashWatch } from "./androidCrashWatch";
import { AndroidEmulatorFailure } from "./androidEmulatorErrors";
import type { AndroidEmulatorStopReason } from "./androidEmulatorOwners";
import {
  launchAndroidEmulator,
  stopAndroidEmulator,
  stopAndroidLaunch,
  waitForAndroidBoot,
  type AdeStartedEmulators,
  type AndroidBootResult,
  type AndroidDiscoveredEmulator,
  type AndroidEmulatorLaunch,
  type AndroidSnapshotMode,
} from "./androidEmulatorProcess";
import { ANDROID_BOOT_TIMEOUT_MS, type AndroidEmulatorServiceDeps, type AndroidLaneState as LaneState } from "./androidEmulatorServiceDeps";
import type { AndroidEmulatorLifecycle as AndroidMachineEmulatorLifecycle } from "./androidEmulatorSweep";
import { reserveAndroidMemoryForStart } from "./androidMemoryGuard";
import type { AndroidEnv, ReadyAndroidSdk } from "./androidSdk";

/*
 * The start and the stop of an emulator ADE runs for a lane, split out of
 * `androidEmulatorService.ts`: the launch, the boot wait, a stop during the
 * boot, and the watch for an emulator that dies after its boot.
 *
 * One implementation serves the lane's own device and its extra devices
 * (`androidLaneExtras.ts`). Each gives its own state (`AndroidEmulatorSlot`)
 * and the hooks where the two are not the same (`AndroidEmulatorSlotHooks`):
 * its event, its log keys, its started-emulators file, the lane's stream.
 *
 * The service calls `startLocked` and `stopLocked` from the lane's queue
 * (`serialize`), and `abortBoot` from a stop that does not wait behind the
 * boot. This module keeps no state of its own: the lane state, the started
 * emulators files and the booted set belong to the service.
 *
 * Every start passes the memory guard first (`androidMemoryGuard.ts`), which
 * counts every running emulator and the boots in flight in every brain (the
 * machine lifecycle's ledger). A launch writes the emulator's machine-wide
 * owner record (`androidEmulatorSweep.ts`), the boot pins it to qemu's pid,
 * and a boot that never finished forgets it. Every stop says why
 * (`AndroidEmulatorStopReason`), so the machine lifecycle drops the record and
 * logs `android.emulator_stopped` once.
 *
 * Node built-ins and relative imports only, so it runs under `tsx`.
 */

/** What a boot, a stop and an exit watch need of one device's state: the lane's own (`LaneState`) or an extra's. */
export type AndroidEmulatorSlot = Pick<LaneState, "laneId" | "transient" | "error" | "launch" | "stopRequested" | "launchStop">;

/** Where the boot, the stop and the exit of the lane's own device and of an extra are not the same. */
export type AndroidEmulatorSlotHooks = {
  avdName: string;
  snapshot: AndroidSnapshotMode;
  /** Its started-emulators file: the project's, or the extras' own (`started-extra-emulators.json`). */
  registry: AdeStartedEmulators;
  /** Its state event: `android.device.state` for the lane's device, `android.extra.state` for an extra. */
  emitState: (state: "starting" | "stopping" | "booted" | "crashed" | "off") => void;
  /** The start of its log keys: `android.` for the lane's device, `android.extra_` for an extra. */
  logPrefix: "android." | "android.extra_";
  /** More fields on its log lines (`extra: true` for an extra). */
  logFields: Record<string, unknown>;
  /** More Sentry tags and extra fields on a boot that failed. */
  sentryTags: Record<string, string>;
  sentryExtra: Record<string, unknown>;
  /** Runs just before its emulator stops (the lane ends its stream). */
  beforeStop: () => Promise<void>;
  /** Its emulator died after its boot (the lane ends its crash watch and its stream). */
  onExited: () => Promise<void>;
  /** A stop ended its boot (an extra says "off" at once). */
  onStoppedWhileStarting: () => void;
};

/** How one start goes: past the memory guard (`force`), with an adb restart the person asked for, for which chat. */
export type AndroidStartOptions = { force?: boolean; restartAdb?: boolean; chatSessionId?: string | null };

export type AndroidEmulatorLifecycleContext = {
  deps: Pick<AndroidEmulatorServiceDeps, "laneDevices" | "dataDir" | "captureAnalytics" | "handOffOnDispose" | "bootTimeoutMs" | "projectRoot">;
  env: AndroidEnv;
  platform: NodeJS.Platform;
  logger: Logger | null;
  /** The project's started-emulators file: the lanes' own devices. */
  registry: AdeStartedEmulators;
  /** The extras' own started-emulators file, which an older ADE never reads. */
  extraRegistry: AdeStartedEmulators;
  discoveryDirs: readonly string[];
  /** `serial:pid` of emulators seen booted (the service's set). */
  bootedSeen: Set<string>;
  /**
   * The brain's emulator lifecycle (`androidEmulatorSweep.ts`): the owner
   * records, the memory guard's cross-brain ledger. Null without one (tests,
   * the desktop's in-process copy).
   */
  machineLifecycle: AndroidMachineEmulatorLifecycle | null;
  /** Every running emulator (the discovery files), the user's and other brains' too: the memory guard counts them all. */
  discovered: () => AndroidDiscoveredEmulator[];
  /** One emulator ADE started stopped: its owner record goes and the stop is logged with why (`androidEmulatorUse.ts`). */
  noteStopped: (emulator: AndroidDiscoveredEmulator, reason: AndroidEmulatorStopReason, laneId: string | null) => void;
  crashWatch: ReturnType<typeof createAndroidCrashWatch>;
  emit: (event: AndroidEmulatorEvent) => void;
  runningFor: (avdName: string) => AndroidDiscoveredEmulator | null;
  ownsEmulator: (emulator: AndroidDiscoveredEmulator) => boolean;
  requireSdk: (needs: { emulator: boolean }) => Promise<ReadyAndroidSdk>;
  laneStatus: (laneId: string, sdk?: AndroidSdkStatus | null) => Promise<AndroidLaneDeviceStatus>;
  emitDeviceState: (laneId: string) => Promise<AndroidLaneDeviceStatus>;
  stopLaneStream: (state: LaneState) => Promise<void>;
  isDisposed: () => boolean;
  /**
   * The emulator finished its boot: the idle timers and the agent suite learn
   * it. Called only after a boot, so it may use parts the service makes later.
   */
  onBooted: (laneId: string) => void;
};

/**
 * The AVD a start boots, once the machine can run it: hardware acceleration
 * is there and the AVD's folder is on disk. Else the refusal (`notFound` is
 * the message for a missing AVD).
 */
export function requireBootableAvd(ready: ReadyAndroidSdk, avdName: string, notFound: string): AndroidAvd {
  if (!ready.sdk.acceleration.usable) {
    throw new AndroidEmulatorFailure(
      "ANDROID_NO_ACCELERATION",
      ready.sdk.acceleration.detail ?? "Hardware acceleration is not available, so the emulator cannot run here.",
    );
  }
  const avd = readAndroidAvd(ready.avdHome, avdName);
  if (!avd) throw new AndroidEmulatorFailure("ANDROID_AVD_NOT_FOUND", notFound);
  return avd;
}

function stoppedWhileStarting(): AndroidEmulatorFailure {
  return new AndroidEmulatorFailure("ANDROID_NOT_RUNNING", "The emulator was stopped while it was starting.");
}

export function createAndroidEmulatorLifecycle(ctx: AndroidEmulatorLifecycleContext) {
  const {
    deps, env, logger, registry, extraRegistry, discoveryDirs, bootedSeen, machineLifecycle, noteStopped, crashWatch,
    emit, runningFor, ownsEmulator, requireSdk, isDisposed,
  } = ctx;
  const bootTimeoutMs = Math.max(deps.bootTimeoutMs ?? ANDROID_BOOT_TIMEOUT_MS, 120_000);

  /* ---------- one device: stop ---------- */

  /**
   * Stops one running emulator ADE started; the stop forgets it in the
   * started-emulators files (the lanes' and the extras') and in the owner file.
   */
  const stopEmulator = async (
    emulator: AndroidDiscoveredEmulator,
    adbPath: string,
    reason: AndroidEmulatorStopReason,
    laneId: string | null,
    launcherPid: number | null = null,
  ) => {
    const result = await stopAndroidEmulator({
      adbPath,
      serial: emulator.serial,
      consolePort: emulator.consolePort,
      avdName: emulator.avdName,
      pid: emulator.pid,
      launcherPid,
      registry,
      discoveryDirs,
    });
    // The emulator is gone, whichever of the two files listed it.
    extraRegistry.forget({ avdName: emulator.avdName, consolePort: emulator.consolePort });
    noteStopped(emulator, reason, laneId);
    return result;
  };

  /** Stops an emulator this process launched, at any point of its boot. A boot that never finished leaves no owner record. */
  const stopLaunch = async (launch: AndroidEmulatorLaunch, adbPath: string, launchRegistry: AdeStartedEmulators): Promise<void> => {
    await stopAndroidLaunch(launch, { adbPath, registry: launchRegistry, discoveryDirs, logger });
    machineLifecycle?.forget({ avdName: launch.avdName, consolePort: launch.consolePort });
  };

  /**
   * Ends a boot in progress: the failing start then reads `stopRequested`.
   * Starts the stop of the booting emulator unless one runs; `adbPath` is
   * asked for only then, and a null one starts none. A failed stop is logged,
   * never thrown.
   */
  const abortSlot = async (slot: AndroidEmulatorSlot, hooks: AndroidEmulatorSlotHooks, adbPath: () => Promise<string | null>): Promise<void> => {
    slot.stopRequested = true;
    if (slot.launch && !slot.launchStop) {
      const resolved = await adbPath();
      if (resolved && slot.launch && !slot.launchStop) slot.launchStop = stopLaunch(slot.launch, resolved, hooks.registry);
    }
    await slot.launchStop?.catch((error: unknown) => {
      logger?.warn(`${hooks.logPrefix}launch_stop_failed`, { laneId: slot.laneId, avdName: hooks.avdName, ...hooks.logFields, error: getErrorMessage(error) });
    });
  };

  /**
   * A stop during a start does not wait behind the boot: the device says
   * "stopping" and its boot ends now, so the start fails with "stopped while
   * it was starting". Nothing happens when no boot runs.
   */
  const interruptSlot = async (slot: AndroidEmulatorSlot, hooks: AndroidEmulatorSlotHooks, adbPath: () => Promise<string | null>): Promise<void> => {
    if (slot.transient !== "starting") return;
    slot.transient = "stopping";
    hooks.emitState("stopping");
    await abortSlot(slot, hooks, adbPath);
  };

  /** Stops the device's emulator if ADE started it, saying why. The caller holds the device's queue. */
  const stopSlot = async (
    slot: AndroidEmulatorSlot,
    hooks: AndroidEmulatorSlotHooks,
    options: { refuseForeign: boolean; reason: AndroidEmulatorStopReason },
  ): Promise<void> => {
    const emulator = runningFor(hooks.avdName);
    if (!emulator) {
      await hooks.beforeStop();
      slot.launch = null;
      return;
    }
    if (!ownsEmulator(emulator)) {
      if (!options.refuseForeign) return;
      throw new AndroidEmulatorFailure(
        "ANDROID_AVD_RUNNING",
        `${hooks.avdName} was started outside ADE, so ADE leaves it running. Close it where it was started.`,
      );
    }
    const { adbPath } = await requireSdk({ emulator: false });
    slot.transient = "stopping";
    hooks.emitState("stopping");
    try {
      await hooks.beforeStop();
      await stopEmulator(
        emulator,
        adbPath,
        options.reason,
        slot.laneId,
        slot.launch?.consolePort === emulator.consolePort ? slot.launch.launcherPid : null,
      );
      bootedSeen.delete(`${emulator.serial}:${emulator.pid}`);
      slot.launch = null;
      slot.error = null;
    } finally {
      slot.transient = null;
    }
  };

  /* ---------- one device: boot and exit ---------- */

  /** Watches an emulator ADE launched, so one that dies after its boot reads as crashed. */
  const watchExit = (slot: AndroidEmulatorSlot, hooks: AndroidEmulatorSlotHooks, launch: AndroidEmulatorLaunch) => {
    void launch.exit.then(async (info) => {
      if (slot.launch !== launch || slot.transient !== null || slot.stopRequested || isDisposed()) return;
      slot.launch = null;
      const how = info.error ?? (info.signal ? `signal ${info.signal}` : `code ${info.code}`);
      slot.error = {
        code: "ANDROID_EMULATOR_EXITED",
        message: `The emulator for ${androidAvdDisplayName(launch.avdName)} exited (${how}).`,
        logPath: launch.logPath,
      };
      logger?.warn(`${hooks.logPrefix}emulator_exited`, { laneId: slot.laneId, avdName: launch.avdName, ...hooks.logFields, how });
      machineLifecycle?.forget({ avdName: launch.avdName, consolePort: launch.consolePort });
      await hooks.onExited();
      hooks.emitState("crashed");
    });
  };

  /**
   * The launch and the boot wait of one device, once its start may go ahead.
   * The caller holds the device's queue. On a boot the device's state is idle
   * again and its exit is watched; the caller says that it booted. A failed
   * boot stops what it launched, says "crashed", reports an unexpected
   * failure to Sentry (only when `report` is true), and throws.
   */
  const bootSlot = async (
    slot: AndroidEmulatorSlot,
    hooks: AndroidEmulatorSlotHooks,
    ready: ReadyAndroidSdk,
    owner: {
      guestRamMb: number;
      costMb: number;
      chatSessionId: string | null;
      launched: (emulator: { avdName: string; consolePort: number; launcherPid: number }) => void;
      restartAdb: boolean;
    },
    report: boolean,
  ): Promise<{ launch: AndroidEmulatorLaunch; boot: AndroidBootResult }> => {
    const { laneId } = slot;
    const { avdName, logPrefix, logFields } = hooks;
    const logPath = path.join(deps.dataDir, "logs", `${avdName}.log`);
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    // One log per AVD, from this start only, so "Open log" and the crash
    // sentence read this boot.
    fs.writeFileSync(logPath, "");
    slot.error = null;
    slot.stopRequested = false;
    slot.launchStop = null;
    slot.transient = "starting";
    hooks.emitState("starting");
    let launch: AndroidEmulatorLaunch | null = null;
    try {
      launch = await launchAndroidEmulator({
        emulatorPath: ready.emulatorPath,
        sdkRoot: ready.root,
        avdHome: ready.avdHome,
        avdName,
        logPath,
        snapshot: hooks.snapshot,
        registry: hooks.registry,
        discoveryDirs,
        env,
        detached: deps.handOffOnDispose === true,
      });
      slot.launch = launch;
      // The machine-wide owner record: this brain owns it from now on.
      const { consolePort, launcherPid } = launch;
      machineLifecycle?.recordLaunch({
        guestRamMb: owner.guestRamMb,
        costMb: owner.costMb,
        chatSessionId: owner.chatSessionId,
        avdName,
        consolePort,
        launcherPid,
        adbPath: ready.adbPath,
        laneId,
        projectRoot: deps.projectRoot ?? null,
      });
      // From here a later start finds this boot's qemu and counts only what it has not taken yet.
      owner.launched({ avdName, consolePort, launcherPid });
      // A stop that came while the launch was still picking ports.
      if (slot.stopRequested) throw stoppedWhileStarting();
      const startedAt = Date.now();
      const boot = await waitForAndroidBoot(launch, {
        adbPath: ready.adbPath,
        timeoutMs: bootTimeoutMs,
        registry: hooks.registry,
        discoveryDirs,
        restartAdb: owner.restartAdb ? "always" : "auto",
        onAdbRestarted: (otherDevices) => {
          logger?.warn("android.adb_server_restarted", { laneId, avdName, ...logFields, reason: "unauthorized", otherDevices, asked: owner.restartAdb });
          deps.captureAnalytics?.("adb_restarted");
        },
        onAdbDevicesFailed: (error) => {
          logger?.warn("android.adb_devices_failed", { laneId, avdName, ...logFields, error });
        },
      });
      if (slot.stopRequested) throw stoppedWhileStarting();
      bootedSeen.add(`${launch.serial}:${boot.pid}`);
      void machineLifecycle?.recordBooted({ avdName, consolePort, pid: boot.pid }).catch((error: unknown) => {
        // Without its owner record the emulator is never idle-stopped or cleaned up.
        logger?.warn("android.owner_record_failed", { avdName, error: getErrorMessage(error) });
      });
      logger?.info(`${logPrefix}emulator_booted`, {
        laneId,
        avdName,
        ...logFields,
        serial: launch.serial,
        waitForDeviceMs: boot.waitForDeviceMs,
        bootCompletedMs: boot.bootCompletedMs,
        totalMs: Date.now() - startedAt,
        adbRestarted: boot.adbRestarted,
      });
      deps.captureAnalytics?.("device_booted");
      slot.transient = null;
      watchExit(slot, hooks, launch);
      return { launch, boot };
    } catch (error) {
      const stoppedByUser = slot.stopRequested;
      if (launch) {
        // A boot that timed out leaves the emulator running; any other failure
        // after the launch may too. Stop it: ADE started it. A stop that
        // arrived during the boot is already doing that.
        slot.transient = "stopping";
        const ending = slot.launchStop ?? (launch.exited() ? Promise.resolve() : stopLaunch(launch, ready.adbPath, hooks.registry));
        await ending.catch((stopError: unknown) => {
          logger?.warn(`${logPrefix}failed_boot_stop_failed`, { laneId, avdName, ...logFields, error: getErrorMessage(stopError) });
        });
        // A boot that never finished leaves no owner record (one that outlived
        // its stop stays ADE's in its started-emulators file).
        machineLifecycle?.forget({ avdName: launch.avdName, consolePort: launch.consolePort });
      }
      slot.transient = null;
      slot.launchStop = null;
      if (slot.launch === launch) slot.launch = null;
      if (stoppedByUser) {
        slot.error = null;
        hooks.onStoppedWhileStarting();
        throw stoppedWhileStarting();
      }
      const failure = error instanceof AndroidEmulatorFailure
        ? error
        : new AndroidEmulatorFailure(
          "ANDROID_EMULATOR_EXITED",
          `The emulator for ${androidAvdDisplayName(avdName)} did not start: ${getErrorMessage(error)}`,
          logPath,
        );
      slot.error = failure.toAndroidEmulatorError();
      const elapsedMs = launch ? Date.now() - launch.startedAt : null;
      logger?.warn(`${logPrefix}emulator_start_failed`, { laneId, avdName, ...logFields, code: failure.code, error: failure.message, elapsedMs });
      // A boot that failed is a failure ADE should hear about, not only a log
      // line: one issue for each code. An expected code (the person's or the
      // machine's state) is not one. `report` is false when the caller's own
      // process reports the failure (the desktop's IPC capture). The failure
      // object itself is captured, so the SDK drops a second capture of it.
      if (report && !failure.adeExpected) {
        captureError(failure, {
          tags: { area: "android", code: failure.code, ...hooks.sentryTags },
          extra: { elapsedMs, ...hooks.sentryExtra },
          fingerprint: ["android", "boot_failed", failure.code],
          handled: true,
        });
      }
      deps.captureAnalytics?.("boot_failed");
      hooks.emitState("crashed");
      throw failure;
    }
  };

  /**
   * Starts one device through the memory guard (`force` starts it past a
   * refusal), then boots it. The caller holds the device's queue and read its
   * AVD. A call that names its chat is an agent's over RPC, which the
   * desktop's IPC capture never sees, so only its failure is reported here.
   */
  const reserveAndBoot = async (
    slot: AndroidEmulatorSlot,
    hooks: AndroidEmulatorSlotHooks,
    ready: ReadyAndroidSdk,
    avd: AndroidAvd,
    options: AndroidStartOptions,
  ): Promise<{ launch: AndroidEmulatorLaunch; boot: AndroidBootResult }> => {
    const force = options.force === true;
    const chatSessionId = options.chatSessionId?.trim() || null;
    const reservation = await reserveAndroidMemoryForStart({
      laneId: slot.laneId,
      avd,
      force,
      platform: ctx.platform,
      logger,
      // Every running emulator counts, the user's and other brains' too.
      discovered: ctx.discovered(),
      ledger: machineLifecycle?.ledger ?? null,
    });
    try {
      const booted = await bootSlot(slot, hooks, ready, {
        guestRamMb: reservation.cost.guestRamMb,
        costMb: reservation.cost.costMb,
        chatSessionId,
        launched: (emulator) => reservation.launched(emulator),
        restartAdb: options.restartAdb === true,
      }, chatSessionId !== null);
      // Started past the memory guard: how often the guard's answer is overruled.
      if (force) deps.captureAnalytics?.("start_forced");
      return booted;
    } finally {
      reservation.release();
    }
  };

  /* ---------- the lane's own device ---------- */

  const laneHooks = (state: LaneState, device: Pick<AndroidLaneDevice, "avdName" | "origin" | "profileId">): AndroidEmulatorSlotHooks => ({
    avdName: device.avdName,
    snapshot: device.origin === "created" ? "cold" : "no-save",
    registry,
    emitState: (next) => emit({ type: "android.device.state", laneId: state.laneId, state: next }),
    logPrefix: "android.",
    logFields: {},
    sentryTags: {},
    sentryExtra: { profileId: device.profileId ?? null, origin: device.origin },
    beforeStop: () => ctx.stopLaneStream(state),
    onExited: async () => {
      crashWatch.stop(state.laneId);
      await ctx.stopLaneStream(state);
    },
    onStoppedWhileStarting: () => {},
  });

  /** The lane's hooks while its row may be gone (a boot in progress after a release). */
  const currentLaneHooks = (state: LaneState): AndroidEmulatorSlotHooks => {
    const device = deps.laneDevices.get(state.laneId);
    const avdName = device?.avdName ?? state.launch?.avdName ?? "";
    return laneHooks(state, { avdName, origin: device?.origin ?? "created", profileId: device?.profileId ?? null });
  };

  /** Ends the lane's boot in progress (`abortSlot`). */
  const abortBoot = (state: LaneState, adbPath: () => Promise<string | null>): Promise<void> =>
    abortSlot(state, currentLaneHooks(state), adbPath);

  /** A stop during the lane's start (`interruptSlot`). */
  const interruptBoot = (state: LaneState, adbPath: () => Promise<string | null>): Promise<void> =>
    interruptSlot(state, currentLaneHooks(state), adbPath);

  /** Stops the lane's emulator if ADE started it, saying why. The caller holds the lane's queue. */
  const stopLocked = async (
    state: LaneState,
    device: AndroidLaneDevice,
    options: { refuseForeign: boolean; reason: AndroidEmulatorStopReason },
  ): Promise<void> => {
    crashWatch.stop(state.laneId);
    await stopSlot(state, laneHooks(state, device), options);
  };

  const startLocked = async (state: LaneState, options: AndroidStartOptions = {}): Promise<AndroidLaneDeviceStatus> => {
    const laneId = state.laneId;
    // The machine first: a lane without a device on a machine that can't run one needs the machine's answer.
    const ready = await requireSdk({ emulator: true });
    const device = deps.laneDevices.get(laneId);
    if (!device) {
      throw new AndroidEmulatorFailure("ANDROID_AVD_NOT_FOUND", "This lane has no Android device. Create or attach one first.");
    }
    const avd = requireBootableAvd(ready, device.avdName, `The lane's AVD ${device.avdName} is no longer on this machine.`);
    // Already running (a start from before a brain restart, or the user's own
    // emulator for an attached AVD): use it as it is.
    if (runningFor(device.avdName)) return ctx.laneStatus(laneId, ready.sdk);
    const { launch } = await reserveAndBoot(state, laneHooks(state, device), ready, avd, options);
    ctx.onBooted(laneId);
    crashWatch.ensure(laneId, { serial: launch.serial, adbPath: ready.adbPath });
    return ctx.emitDeviceState(laneId);
  };

  /**
   * Promote: the lane's state takes an emulator this process launched for an
   * extra, so a stop passes its launcher pid and a later exit reads as crashed.
   */
  const adoptLaunch = (state: LaneState, device: AndroidLaneDevice, launch: AndroidEmulatorLaunch | null): void => {
    state.launch = launch;
    state.error = null;
    if (launch) watchExit(state, laneHooks(state, device), launch);
  };

  return {
    stopEmulator,
    abortBoot,
    interruptBoot,
    stopLocked,
    startLocked,
    adoptLaunch,
    /** The one boot, stop, abort and exit watch, for the extras (`androidLaneExtras.ts`). */
    slots: { reserveAndBoot, abort: abortSlot, interrupt: interruptSlot, stop: stopSlot, watchExit },
  };
}

export type AndroidEmulatorSlots = ReturnType<typeof createAndroidEmulatorLifecycle>["slots"];
