/**
 * The Android emulator's shared contract: what the brain reports about the
 * SDK, the AVDs on a machine, the one emulator a lane holds, and the stream
 * and input a viewer uses.
 *
 * Plan: `docs/plans/android-emulator.md`. Emulators only (no physical phones),
 * so a device here is always an AVD that this machine's SDK can boot.
 */

import type { OpenProjectBinding } from "./core";
import type { AndroidAppCrash, AndroidCapabilities, AndroidEmulatorAgentServiceApi, AndroidRecording } from "./androidEmulatorAgent";
import type { AndroidEmulatorPostureServiceApi, AndroidPosture } from "./androidEmulatorPosture";
import type { AndroidEmulatorToolsPreloadApi } from "./androidEmulatorDrawer";
import type { AndroidEmulatorLookPreloadApi, AndroidEmulatorLookServiceApi, AndroidRenderRequestEvent } from "./androidEmulatorLook";
import type { AndroidEmulatorSetupPreloadApi, AndroidEmulatorSetupServiceApi, AndroidSdkInstallState } from "./androidEmulatorSetup";
import type { AndroidEmulatorImagesServiceApi } from "./androidEmulatorImages";
import type { AndroidEmulatorInstrumentationServiceApi } from "./androidEmulatorInstrumentation";
import type { AndroidEmulatorPreviewServiceApi } from "./androidEmulatorPreviews";
import type { RuntimeDisposeReason } from "./runtimeLifecycle";
import type {
  AndroidEmulatorRecordingServiceApi,
  AndroidInputRecordArgs,
  AndroidMachinePreferences,
  AndroidMachinePreferencesResult,
} from "./androidEmulatorRecording";
import type { AndroidEmulatorControlServiceApi, AndroidPowerOffRecord } from "./androidEmulatorControl";
import { ANDROID_CONTROL_ACTIONS } from "./androidEmulatorControl";
import type { AndroidEmulatorDeviceServiceApi, AndroidOrientationEvent } from "./androidEmulatorDevice";
import { ANDROID_DEVICE_ACTIONS, ANDROID_ROTATE_ORIENTATIONS } from "./androidEmulatorDevice";
import type { AndroidDeviceTargetArgs, AndroidEmulatorExtrasServiceApi, AndroidLaneExtraStatus } from "./androidEmulatorExtras";
import { ANDROID_EXTRA_DEVICE_ACTIONS } from "./androidEmulatorExtras";

/**
 * The Android panel's product facts (`ade_feature_used`, `action: "android_device"`):
 * whether the guided SDK install, app installs, renders, agent leases, the phone and web
 * viewers, and starts past the RAM guard are used at all. P3 adds a system image
 * installed from the image manager, and an instrumentation test run.
 * Closed: a spelling not listed here is dropped by the analytics policy, not widened.
 */
export const ANDROID_DEVICE_ANALYTICS_OUTCOMES = [
  "sdk_installed",
  "app_installed",
  "device_rendered",
  "device_leased",
  "remote_viewed",
  "start_forced",
  "image_installed",
  "tests_run",
  // P3: a fold the emulator settled, and a Compose preview render that wrote an image.
  "device_folded",
  "previews_rendered",
  // ADE stopped an emulator by itself: nobody used it for the idle limit, or
  // the brain that started it was gone and nothing adopted it.
  "emulator_auto_stopped",
  // Parity: a Play Store screenshot set was taken (Apple's `duo_app_store_shots`).
  "store_screenshots",
  // Boot health: a start that booted, one that failed, and an adb server
  // restart that ADE made so a refused (`unauthorized`) device could boot.
  "device_booted",
  "boot_failed",
  "adb_restarted",
  // Extra devices: a lane made a second device beside its own (Apple's
  // `extra_device_created`), and an extra became the lane's device.
  "extra_device_created",
  "device_promoted",
] as const;
export type AndroidDeviceAnalyticsOutcome = (typeof ANDROID_DEVICE_ANALYTICS_OUTCOMES)[number];

/** Where an SDK path came from, in the order the brain tries them. */
export type AndroidSdkSource = "ANDROID_HOME" | "ANDROID_SDK_ROOT" | "default" | "setting";

/** One SDK part the brain needs, and whether this machine has it. */
export type AndroidSdkTool = {
  id: "platform-tools" | "emulator" | "cmdline-tools" | "system-image";
  available: boolean;
  /** Absolute path of the binary or folder, when found. */
  path: string | null;
  version: string | null;
  /** One plain sentence for the setup card when the part is missing. */
  detail: string | null;
};

/**
 * Hardware acceleration for the emulator. Without it an x86_64 or arm64 image
 * runs, if at all, many times slower, so the panel shows it first.
 */
export type AndroidAcceleration = {
  /** `HVF` (macOS), `WHPX` or `AEHD` (Windows), `KVM` (Linux). */
  kind: "HVF" | "WHPX" | "AEHD" | "KVM" | null;
  usable: boolean;
  /** `emulator -accel-check` output reduced to one sentence. */
  detail: string | null;
};

export type AndroidSdkStatus = {
  /** False when no SDK root was found at all. */
  found: boolean;
  root: string | null;
  source: AndroidSdkSource | null;
  tools: AndroidSdkTool[];
  acceleration: AndroidAcceleration;
  /** `x86_64` or `arm64-v8a`: the only system-image ABI this host runs fast. */
  hostAbi: "x86_64" | "arm64-v8a";
  /** The folder that holds the AVDs (`ANDROID_AVD_HOME` or `~/.android/avd`). */
  avdHome: string | null;
  /** When this status was read; the brain re-reads on use, not only at start. */
  checkedAt: string;
};

/** One installed system image (`system-images;android-36;google_apis_playstore;x86_64`). */
export type AndroidSystemImage = {
  /** The sdkmanager package path. */
  packageId: string;
  apiLevel: number;
  /** `google_apis_playstore`, `google_apis`, `default`, … */
  tag: string;
  abi: string;
  path: string;
};

/** A hardware profile the SDK or ADE defines (`pixel_9_pro_fold`, `medium_phone`). */
export type AndroidHardwareProfile = {
  id: string;
  name: string;
  /** Who defines it. P1 adds `ade` profiles for non-Pixel catalog phones. */
  origin: "sdk" | "ade" | "user";
  screenInches: number | null;
  widthPx: number | null;
  heightPx: number | null;
  density: number | null;
  /** `phone`, `tablet`, `foldable`, `wear`, `tv`, `automotive`, `desktop`. */
  formFactor: string | null;
};

/** One AVD folder on this machine. */
export type AndroidAvd = {
  /** The AVD name `emulator -avd <name>` takes. */
  name: string;
  displayName: string | null;
  /** `hw.device.name` from `config.ini`. */
  profileId: string | null;
  apiLevel: number | null;
  tag: string | null;
  abi: string | null;
  lcdWidth: number | null;
  lcdHeight: number | null;
  density: number | null;
  /** P2 RAM guard: the guest RAM in MB (`hw.ramSize`), when `config.ini` says. */
  ramMb: number | null;
  /** The AVD folder (`<avdHome>/<name>.avd`). */
  path: string;
  /** Bytes on disk, when measured. */
  sizeBytes: number | null;
  /** ADE created this AVD (it carries ADE's marker in `config.ini`). */
  adeCreated: boolean;
  /** P1 look: the brand catalog entry it was made from (`ade.catalogId`), if any. */
  catalogId?: string | null;
  /** P1 look: the body colour picked for it (`ade.color`), if any. */
  colorId?: string | null;
  /** Set while an emulator runs this AVD. */
  running: AndroidRunningEmulator | null;
};

/** A running emulator, from its discovery file (`avd/running/pid_<pid>.ini`). */
export type AndroidRunningEmulator = {
  avdName: string;
  /** `emulator-<consolePort>`, the adb serial. */
  serial: string;
  consolePort: number;
  adbPort: number;
  grpcPort: number | null;
  /** The qemu process id (the discovery file's key), not the launcher's. */
  pid: number;
  /** True when this emulator needs a gRPC token (one ADE did not start). */
  grpcTokenRequired: boolean;
  /** ADE started this process; ADE stops only what it started. */
  startedByAde: boolean;
  /** `sys.boot_completed` read 1. */
  booted: boolean;
};

/** The lane's device row (local-only table `lane_android_devices`). */
export type AndroidLaneDevice = {
  laneId: string;
  avdName: string;
  /** `created` = ADE made it for this lane; `attached` = the user's own AVD. */
  origin: "created" | "attached";
  profileId: string | null;
  systemImage: string | null;
  createdAt: string;
  /** Package names ADE installed, so release can uninstall only those. */
  adeInstalledPackages: string[];
  /**
   * One of the lane's extra devices (`device-create --extra`), not its own
   * device: reached with `--device <avd>`, never the default target, never
   * streamed in the pane. Absent on the lane's device.
   */
  extra?: boolean;
};

/** The emulator the lane holds, as the panel reads it. */
export type AndroidLaneDeviceStatus = {
  laneId: string;
  device: AndroidLaneDevice | null;
  avd: AndroidAvd | null;
  state: "none" | "off" | "starting" | "booted" | "stopping" | "crashed";
  /** Set when `state` is `crashed` or a start failed. */
  error: AndroidEmulatorError | null;
  /** P2 crash pin: the lane's app's last crash while the emulator runs. Absent from a brain before P2. */
  appCrash?: AndroidAppCrash | null;
  /**
   * "Keep running": true when the person pinned the running emulator, so
   * ADE's idle stop leaves it alone; false when ADE stops it after
   * `idleStopMinutes` unused. Null when it is not running, or ADE did not
   * start it (ADE never stops those). Absent from an older brain.
   */
  keepRunning?: boolean | null;
  /** How long ADE lets an unpinned emulator sit unused before it stops it; null when the idle stop is off. */
  idleStopMinutes?: number | null;
  /** Parity: why ADE powered the emulator off (the idle stop, or a cleanup pass's power-off), until the next start. */
  poweredOff?: AndroidPowerOffRecord | null;
  /** The lane's extra devices (`device-create --extra`), oldest first. Absent from an older brain. */
  extras?: AndroidLaneExtraStatus[];
};

/**
 * How a local viewer opens the stream. The records are the shared video
 * records (`media/videoRecords.ts`): the same reader plays iOS, Mac Desktop and
 * Android.
 */
export type AndroidStreamTransport = {
  url: string;
  token: string;
  codec: string;
  width: number;
  height: number;
};

export type AndroidStreamStatus = {
  laneId: string;
  running: boolean;
  backend: "scrcpy" | null;
  transport: AndroidStreamTransport | null;
  /** Frames per second over the last few seconds, when running. */
  fps: number | null;
  /** The bit rate the encoder sent over the last few seconds, in kbit/s, when running. */
  bitrateKbps?: number | null;
  /** The encoder's bit rate setting now, in kbit/s: lower while only remote viewers read. */
  capKbps?: number | null;
};

/** One touch event in device pixels. */
export type AndroidTouchEvent = {
  action: "down" | "move" | "up";
  x: number;
  y: number;
  /** Pointer id, for multi-touch. */
  pointerId?: number;
};

/** The hardware and navigation keys the rail sends. */
export const ANDROID_HARDWARE_KEYS = [
  "back",
  "home",
  "recents",
  "power",
  "volume_up",
  "volume_down",
] as const;
export type AndroidHardwareKey = (typeof ANDROID_HARDWARE_KEYS)[number];

export function isAndroidHardwareKey(value: unknown): value is AndroidHardwareKey {
  return typeof value === "string" && (ANDROID_HARDWARE_KEYS as readonly string[]).includes(value);
}

export const ANDROID_EMULATOR_ERROR_CODES = [
  "ANDROID_SDK_NOT_FOUND",
  "ANDROID_TOOL_MISSING",
  "ANDROID_NO_ACCELERATION",
  "ANDROID_NO_SYSTEM_IMAGE",
  "ANDROID_AVD_NOT_FOUND",
  "ANDROID_AVD_HELD_BY_OTHER_LANE",
  /** The lane already holds an AVD; release it before making or attaching another. */
  "ANDROID_LANE_HAS_DEVICE",
  /** `device-create --extra` on a lane that already holds its limit of extra devices. */
  "ANDROID_EXTRA_DEVICE_LIMIT",
  /** `device-attach` naming one of this lane's extra devices: promote it instead. */
  "ANDROID_DEVICE_IS_EXTRA",
  /** `--device` names neither the lane's device nor one of its extra devices. */
  "ANDROID_DEVICE_NOT_LANE_OWNED",
  /** `device-promote` refused: the lane's device (or the extra) is in use now. */
  "ANDROID_LANE_DEVICE_BUSY",
  /** The AVD already runs (one AVD boots once at a time). */
  "ANDROID_AVD_RUNNING",
  "ANDROID_NO_FREE_PORT",
  "ANDROID_BOOT_TIMEOUT",
  /**
   * The emulator runs, but the adb server refuses it as `unauthorized`: the
   * server holds an older adb key than the one the emulator trusts.
   * `start` with `restartAdb` restarts the adb server and boots again.
   */
  "ANDROID_ADB_UNAUTHORIZED",
  "ANDROID_EMULATOR_EXITED",
  "ANDROID_STREAM_FAILED",
  "ANDROID_NOT_RUNNING",
  /** A screenshot `outPath` that resolves outside the lane's worktree. */
  "ANDROID_PATH_OUTSIDE_LANE",
  // P1 setup (coordinator): the guided SDK install.
  /** A licence the install needs was not accepted in this request. */
  "ANDROID_SDK_LICENSE_NOT_ACCEPTED",
  /** The install folder's disk has too little free space. */
  "ANDROID_SDK_NO_SPACE",
  /** Another install runs on this machine (this process or another one). */
  "ANDROID_SDK_INSTALL_BUSY",
  /** A download, a checksum or an unzip failed. */
  "ANDROID_SDK_INSTALL_FAILED",
  /** "Use mine…" named a folder that is not an Android SDK, or the install folder is not usable. */
  "ANDROID_SDK_PATH_INVALID",
  /** P2 RAM guard: the start would push the machine into swap. `start` with `force` starts it anyway. */
  "ANDROID_LOW_MEMORY",
] as const;
export type AndroidEmulatorErrorCode = (typeof ANDROID_EMULATOR_ERROR_CODES)[number];

export type AndroidEmulatorError = {
  code: AndroidEmulatorErrorCode;
  /** One plain sentence for the panel. */
  message: string;
  /** The emulator log path, when there is one ("Open log"). */
  logPath?: string | null;
  /**
   * `ANDROID_ADB_UNAUTHORIZED` after ADE already restarted the adb server: a
   * new restart does not help (the emulator does not trust the current key),
   * so the pane offers none.
   */
  adbRestarted?: boolean;
};

/* ──────────────────────────────────────────────────────────────────────────
   SERVICE, ACTIONS AND PRELOAD (P0, phase B)

   One `AndroidEmulatorServiceApi` per brain. The `android_emulator` action
   domain, the IPC handlers and `ade android` all call these methods; the
   renderer reaches them through `window.ade.androidEmulator`, which takes an
   optional `pin` so a call goes to the machine that owns the lane.
   ────────────────────────────────────────────────────────────────────────── */

/** The runtime action domain name. */
export const ANDROID_EMULATOR_DOMAIN = "android_emulator" as const;

/** What this host can do, before any lane is involved. */
export type AndroidEmulatorStatus = {
  /**
   * False only when this host can never run the emulator (no supported OS or
   * CPU). A missing SDK is NOT unsupported: the panel shows the setup card.
   */
  platformSupported: boolean;
  /** One sentence when `platformSupported` is false. */
  unsupportedReason: string | null;
  sdk: AndroidSdkStatus;
  /** The lane's device, when the call named a lane. */
  lane: AndroidLaneDeviceStatus | null;
  /** P1 agent suite: what this machine can do now. Absent from an older brain. */
  capabilities?: AndroidCapabilities | null;
};

export type AndroidAvdListing = AndroidAvd & {
  /** The lane that holds this AVD, if any (`lane_android_devices`). */
  heldByLaneId: string | null;
  /**
   * ADE made this AVD for a lane that is not in this project (another
   * project's lane, or one deleted since). The panel badges it; attaching it
   * never lets this project delete it.
   */
  madeForOtherLane: boolean;
  /** The lane in `heldByLaneId` holds it as one of its extra devices, not as its own. */
  heldAsExtra?: boolean;
};

export type AndroidDeviceInventory = {
  avds: AndroidAvdListing[];
  profiles: AndroidHardwareProfile[];
  images: AndroidSystemImage[];
};

export type AndroidLaneArgs = { laneId: string };

/**
 * `start`. `force` boots even when the memory guard says the machine has too
 * little memory. `restartAdb` restarts the machine's adb server when the
 * device stays `unauthorized`, even while other devices use that server (the
 * person's answer to `ANDROID_ADB_UNAUTHORIZED`). `chatSessionId` (stamped by
 * the RPC server for an agent) goes into the emulator's owner record.
 */
export type AndroidStartArgs = AndroidDeviceTargetArgs & {
  force?: boolean;
  restartAdb?: boolean;
};

/** `stop`. `device` names one of the lane's extra devices; default: the lane's device. */
export type AndroidStopArgs = AndroidDeviceTargetArgs;

/** `setKeepRunning`: pin the lane's running emulator so ADE's idle stop leaves it alone, or unpin it. */
export type AndroidKeepRunningArgs = AndroidLaneArgs & { keepRunning: boolean };

/** `listDevices`. `measureSizes` (P1 look, Storage) walks each AVD folder for `sizeBytes`. */
export type AndroidListDevicesArgs = { laneId?: string | null; measureSizes?: boolean };

export type AndroidCreateDeviceArgs = AndroidLaneArgs & {
  profileId: string;
  /** A system image package id; omitted = the newest installed image for the host ABI. */
  systemImage?: string | null;
  displayName?: string | null;
  /** Boot it right after create (the panel's one-click create). Default true. */
  start?: boolean;
  /**
   * P1 look: a brand catalog entry (`shared/androidDeviceCatalog.ts`). With
   * it, `profileId` may be empty: the brain resolves the entry's profile
   * (and writes an `ade_*` one when the entry needs it).
   */
  catalogId?: string | null;
  /** P1 look: the catalog entry's colour id, recorded on the AVD. */
  colorId?: string | null;
  /**
   * Make an EXTRA device for the lane instead of its own one: the lane keeps
   * its device, and the new one boots beside it (unless `start` is false).
   * Deleted with the lane, like the lane's own. At most
   * `ANDROID_LANE_EXTRA_DEVICE_LIMIT` per lane by default.
   */
  extra?: boolean | null;
  /** Set by the RPC server for an agent: the boot names the chat in its owner record, and reports a failure. */
  chatSessionId?: string | null;
};

export type AndroidAttachDeviceArgs = AndroidLaneArgs & {
  avdName: string;
  /** Boot it right after attach. Default true. */
  start?: boolean;
  /** Set by the RPC server for an agent, as on `createDevice`. */
  chatSessionId?: string | null;
};

/** `device`: one of the lane's extra devices; release that one and keep the lane's device. Default: the lane's device (its extras stay). */
export type AndroidReleaseDeviceArgs = AndroidDeviceTargetArgs & {
  /**
   * For an AVD ADE created: delete it (default true). An attached user AVD is
   * never deleted; ADE only uninstalls the packages it installed.
   */
  deleteCreated?: boolean;
};

export type AndroidReleaseDeviceResult = {
  released: boolean;
  deletedAvd: string | null;
  /** The released device was one of the lane's extra devices. */
  extra?: boolean;
};

export type AndroidStartStreamArgs = AndroidLaneArgs & {
  /** Long side of the video in pixels. Default from the stream defaults. */
  maxSize?: number | null;
  bitRateBps?: number | null;
  maxFps?: number | null;
  /**
   * The viewer is on another machine (a desktop pinned to this one). It
   * counts as a remote viewer: while no viewer on this machine and no
   * recording holds the stream, the encoder runs at the machine's remote
   * bitrate cap. Pass it on the stop and the status read too.
   */
  remoteViewer?: boolean | null;
};

/** `stopStream` and `getStreamStatus`: `remoteViewer` names the viewer that started it. */
export type AndroidStreamViewerArgs = AndroidLaneArgs & { remoteViewer?: boolean | null };

export type AndroidTouchArgs = AndroidLaneArgs & AndroidInputRecordArgs & { events: AndroidTouchEvent[] };
export type AndroidTapArgs = AndroidLaneArgs & AndroidInputRecordArgs & { x: number; y: number };
export type AndroidSwipeArgs = AndroidLaneArgs & AndroidInputRecordArgs & {
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
  durationMs?: number | null;
};
export type AndroidKeyArgs = AndroidLaneArgs & AndroidInputRecordArgs & { key: AndroidHardwareKey };
/** Parity: `ade apple rotate`'s four names, and `landscape` (= `landscape-right`) for older callers. */
export type AndroidOrientation = (typeof ANDROID_ROTATE_ORIENTATIONS)[number];
export const ANDROID_ORIENTATIONS: readonly AndroidOrientation[] = ANDROID_ROTATE_ORIENTATIONS;
/** Locks the display to this orientation (auto-rotate off). An app that fixes its own orientation keeps it. */
export type AndroidRotateArgs = AndroidLaneArgs & { orientation: AndroidOrientation };
export type AndroidTextArgs = AndroidLaneArgs & AndroidInputRecordArgs & {
  text: string;
  /** Parity (`type --submit`): press Enter after the text, as `ade apple type --submit`. */
  submit?: boolean | null;
};

export type AndroidScreenshotArgs = AndroidLaneArgs & {
  /** Absolute path to write the PNG to; omitted = a file under the ADE data folder. */
  outPath?: string | null;
  /** P1 agent suite: the calling chat, set by the runtime for an agent. The proof is filed to it. */
  chatSessionId?: string | null;
  /** P1 agent suite: false = write the PNG but file no proof (a `--machine` caller files it itself). */
  proof?: boolean;
  /** P1 agent suite: the proof's title. */
  caption?: string | null;
};

export type AndroidScreenshot = {
  path: string;
  width: number;
  height: number;
  bytes: number;
  capturedAt: string;
  /** P1 agent suite: the proof drawer row it was filed as; null when not filed. */
  proofArtifactId?: string | null;
};

/** Pushed to every viewer; the renderer re-reads status on these. */
export type AndroidEmulatorEvent =
  | { type: "android.device.state"; laneId: string; state: AndroidLaneDeviceStatus["state"] }
  | { type: "android.stream.state"; laneId: string; running: boolean }
  | { type: "android.inventory.changed" }
  | { type: "android.sdk.changed" }
  /** The machine's Android preferences changed (`setMachinePreferences`). */
  | { type: "android.preferences.changed"; preferences: AndroidMachinePreferences }
  | { type: "android.sdk.install"; install: AndroidSdkInstallState }
  /** A recording started or ended; `recording.active` says which. */
  | { type: "android.recording.state"; laneId: string; recording: AndroidRecording }
  /** P2 crash pin: the lane's app crashed. */
  | { type: "android.app.crashed"; laneId: string; crash: AndroidAppCrash }
  /** P3 fold: the hinge moved (from any viewer or an agent). */
  | { type: "android.device.posture"; laneId: string; posture: AndroidPosture }
  /** One of the lane's extra devices changed state (`android.device.state` is the lane device's alone). */
  | { type: "android.extra.state"; laneId: string; avdName: string; state: AndroidLaneExtraStatus["state"] | "none" }
  /** Parity: the display turned (a rotate from any caller). */
  | AndroidOrientationEvent
  | AndroidRenderRequestEvent;

export type AndroidEmulatorServiceApi = {
  getStatus(args?: { laneId?: string | null }): Promise<AndroidEmulatorStatus>;
  listDevices(args?: AndroidListDevicesArgs): Promise<AndroidDeviceInventory>;
  /** Make a new AVD for the lane from a profile and hold it. */
  createDevice(args: AndroidCreateDeviceArgs): Promise<AndroidLaneDeviceStatus>;
  /** Hold an existing (user or free ADE) AVD for the lane. */
  attachDevice(args: AndroidAttachDeviceArgs): Promise<AndroidLaneDeviceStatus>;
  /** Boot the lane's AVD, or one of its extras with `device` (no-op when already booted). */
  start(args: AndroidStartArgs): Promise<AndroidLaneDeviceStatus>;
  /** Stop the lane's emulator (or one of its extras) if ADE started it. */
  stop(args: AndroidStopArgs): Promise<AndroidLaneDeviceStatus>;
  /** "Keep running": pin or unpin the lane's running emulator against ADE's idle stop. */
  setKeepRunning(args: AndroidKeepRunningArgs): Promise<AndroidLaneDeviceStatus>;
  releaseDevice(args: AndroidReleaseDeviceArgs): Promise<AndroidReleaseDeviceResult>;
  /** Delete an ADE-created AVD that no lane holds. User-only. */
  deleteDevice(args: { avdName: string }): Promise<{ deleted: boolean }>;
  /** Mints the loopback stream token: viewers only, never a session-bound agent. */
  startStream(args: AndroidStartStreamArgs): Promise<AndroidStreamStatus>;
  stopStream(args: AndroidStreamViewerArgs): Promise<AndroidStreamStatus>;
  /** Redacted: `transport` is always null here. */
  getStreamStatus(args: AndroidStreamViewerArgs): Promise<AndroidStreamStatus>;
  sendTouch(args: AndroidTouchArgs): Promise<void>;
  tap(args: AndroidTapArgs): Promise<void>;
  swipe(args: AndroidSwipeArgs): Promise<void>;
  sendKey(args: AndroidKeyArgs): Promise<void>;
  sendText(args: AndroidTextArgs): Promise<void>;
  rotate(args: AndroidRotateArgs): Promise<void>;
  screenshot(args: AndroidScreenshotArgs): Promise<AndroidScreenshot>;
  /** Lane archive/delete: stop the lane's stream and emulator. Not an action. */
  stopForLane(laneId: string): Promise<void>;
  /**
   * Stop every stream. A service built to hand off (the brain) leaves ADE's
   * emulators running for the next brain to re-adopt; otherwise every
   * emulator ADE started is stopped too. `reason: "unregister"` (the project
   * was removed from this machine, so nothing will re-adopt them) stops them
   * even on a hand-off service. Not an action.
   */
  dispose(options?: { reason?: RuntimeDisposeReason }): Promise<void>;
  onEvent(listener: (event: AndroidEmulatorEvent) => void): () => void;
} & AndroidEmulatorLookServiceApi & AndroidEmulatorAgentServiceApi & AndroidEmulatorSetupServiceApi & AndroidEmulatorPostureServiceApi
  & AndroidEmulatorImagesServiceApi & AndroidEmulatorInstrumentationServiceApi & AndroidEmulatorPreviewServiceApi
  & AndroidEmulatorRecordingServiceApi & AndroidEmulatorControlServiceApi & AndroidEmulatorDeviceServiceApi
  & AndroidEmulatorExtrasServiceApi;

/**
 * P1 agent suite (android-agent): the actions `ade android` adds for agents.
 * Declared before `ANDROID_AGENT_ACTIONS`, which spreads it. Every one acts on
 * the lane's own emulator; the types are in the "P1 AGENT SUITE" block below.
 */
export const ANDROID_AGENT_SUITE_ACTIONS = [
  "listApps",
  "installApp",
  "launchApp",
  "terminateApp",
  "uninstallApp",
  "openUrl",
  "longPress",
  "drag",
  "scroll",
  "getScreenSnapshot",
  "findElement",
  "tapElement",
  "fillElement",
  "waitForElement",
  "assertVisible",
  "readLog",
  "recordStart",
  "recordStop",
  "recordList",
  "recordDelete",
  // Rec: the lane's auto-record switch (`ade android auto-record`).
  "getAutoRecord",
  "setAutoRecord",
  "deviceLease",
  "deviceLeaseRelease",
  "deviceLeaseStatus",
  "setLocation",
  "setAppearance",
  "setPermission",
  "captureProofBundle",
  "getDeviceSettings",
  "setDeviceSetting",
  // P3 fold.
  "getPosture",
  "setPosture",
  // P3 Compose previews (no emulator needed).
  "listComposePreviews",
  "renderComposePreviews",
] as const;
export type AndroidAgentSuiteAction = (typeof ANDROID_AGENT_SUITE_ACTIONS)[number];

/** Actions an agent may call (a session-bound agent, through the action bus and `ade android`). */
export const ANDROID_AGENT_ACTIONS = [
  "getStatus",
  "listDevices",
  "createDevice",
  "attachDevice",
  "start",
  "stop",
  // "Keep running": the pin against ADE's idle stop.
  "setKeepRunning",
  "releaseDevice",
  "getStreamStatus",
  "tap",
  "swipe",
  "sendKey",
  "sendText",
  "rotate",
  "screenshot",
  // P1 look: `ade android render` (a desktop window draws it).
  "requestRender",
  // P1 setup: an agent may read what is missing, never install.
  "getSdkSetupPlan",
  "getSdkInstallState",
  // P1 agent suite (android-agent): apps, input, UI tree, logs, record, lease, emulator controls.
  ...ANDROID_AGENT_SUITE_ACTIONS,
  // P3: the system image list (a read; install and remove are the person's), and instrumentation tests.
  "listSystemImages",
  "runInstrumentationTests",
  // Rec: the machine preferences (a read; the write is the person's).
  "getMachinePreferences",
  // Parity: keys, relaunch, app state, the app in front, frame, Inspect, the cleanup pass.
  ...ANDROID_CONTROL_ACTIONS,
  // Parity: status bar, Clear location, Play Store screenshots, window layout.
  ...ANDROID_DEVICE_ACTIONS,
  // Extra devices: one of the lane's extras becomes its own device.
  ...ANDROID_EXTRA_DEVICE_ACTIONS,
] as const;
export type AndroidAgentAction = (typeof ANDROID_AGENT_ACTIONS)[number];

/**
 * The SDK setup writes only a person may make: accepting Google's licences,
 * writing gigabytes to disk, and the machine's SDK choice. The person makes
 * them in the desktop app (the setup card, or Settings > Android devices);
 * the RPC server, the action policy (`ADE_ACTION_USER_ONLY`), `android.invoke`
 * and ADE MCP all refuse them to anyone else.
 */
export const ANDROID_SDK_PERSON_ONLY_ACTIONS = [
  "installSdk",
  "cancelSdkInstall",
  "setSdkPath",
  // P3 system images: a download with a licence, and a removal that can leave AVDs without an image.
  "installSystemImage",
  "removeSystemImage",
  // Rec: the machine's Android preferences (Settings › Android devices).
  "setMachinePreferences",
] as const;
export type AndroidSdkPersonOnlyAction = (typeof ANDROID_SDK_PERSON_ONLY_ACTIONS)[number];

/** Actions only a viewing client (desktop, web, phone at cto role) may call. */
export const ANDROID_USER_ONLY_ACTIONS = [
  "startStream",
  "stopStream",
  "sendTouch",
  "deleteDevice",
  // P1 look: the body colour, and the window side of a render.
  "setDeviceColor",
  "renderAck",
  "renderComplete",
  "attachRenderProof",
  // P1 setup.
  ...ANDROID_SDK_PERSON_ONLY_ACTIONS,
] as const;
export type AndroidUserOnlyAction = (typeof ANDROID_USER_ONLY_ACTIONS)[number];

/**
 * Actions only the person may take, from the desktop app (`ADE_ACTION_USER_ONLY`),
 * as Apple's `APPLE_USER_ONLY_ACTIONS`: the SDK install and the SDK folder
 * (Google's licences are theirs to accept), deleting an AVD, and filing the
 * render a window drew. An agent and a terminal with no desktop are refused.
 */
export const ANDROID_PERSON_ONLY_ACTIONS = [
  ...ANDROID_SDK_PERSON_ONLY_ACTIONS,
  "deleteDevice",
  "attachRenderProof",
] as const;

/**
 * Actions about the machine, not a lane: status, the AVD list and the SDK
 * setup. They need no lane, and with `--machine` they never make a work copy.
 */
export const ANDROID_LANE_FREE_ACTIONS = [
  "getStatus",
  "listDevices",
  "getSdkSetupPlan",
  "getSdkInstallState",
  // P3: the machine's system images.
  "listSystemImages",
  // Parity: the cleanup pass is about the machine's lanes (an agent's is pinned to its lane).
  "deviceCleanup",
  // Rec: the machine's Android preferences.
  "getMachinePreferences",
  ...ANDROID_SDK_PERSON_ONLY_ACTIONS,
] as const;

/**
 * Actions that build or install from the lane's folder (an APK path, the
 * Gradle wrapper): with `--machine` the work copy there gets the caller's
 * code first. Every other action uses the copy as it is.
 */
export const ANDROID_CODE_SYNC_ACTIONS = [
  "installApp",
  "launchApp",
  // P3: instrumentation tests build the lane's app and its test APK, and
  // Compose previews build the lane's module.
  "runInstrumentationTests",
  "listComposePreviews",
  "renderComposePreviews",
] as const;

type Pin = OpenProjectBinding | null | undefined;

/** `window.ade.androidEmulator`. Every call takes the optional machine pin last. */
export type AndroidEmulatorPreloadApi = {
  getStatus(args?: { laneId?: string | null }, pin?: Pin): Promise<AndroidEmulatorStatus>;
  listDevices(args?: AndroidListDevicesArgs, pin?: Pin): Promise<AndroidDeviceInventory>;
  createDevice(args: AndroidCreateDeviceArgs, pin?: Pin): Promise<AndroidLaneDeviceStatus>;
  attachDevice(args: AndroidAttachDeviceArgs, pin?: Pin): Promise<AndroidLaneDeviceStatus>;
  start(args: AndroidStartArgs, pin?: Pin): Promise<AndroidLaneDeviceStatus>;
  stop(args: AndroidStopArgs, pin?: Pin): Promise<AndroidLaneDeviceStatus>;
  releaseDevice(args: AndroidReleaseDeviceArgs, pin?: Pin): Promise<AndroidReleaseDeviceResult>;
  deleteDevice(args: { avdName: string }, pin?: Pin): Promise<{ deleted: boolean }>;
  startStream(args: AndroidStartStreamArgs, pin?: Pin): Promise<AndroidStreamStatus>;
  stopStream(args: AndroidStreamViewerArgs, pin?: Pin): Promise<AndroidStreamStatus>;
  getStreamStatus(args: AndroidStreamViewerArgs, pin?: Pin): Promise<AndroidStreamStatus>;
  sendTouch(args: AndroidTouchArgs, pin?: Pin): Promise<void>;
  sendKey(args: AndroidKeyArgs, pin?: Pin): Promise<void>;
  sendText(args: AndroidTextArgs, pin?: Pin): Promise<void>;
  rotate(args: AndroidRotateArgs, pin?: Pin): Promise<void>;
  screenshot(args: AndroidScreenshotArgs, pin?: Pin): Promise<AndroidScreenshot>;
  /** Rec: the machine's Android preferences, on the machine the pin names (Settings › Android devices). */
  getMachinePreferences(args?: Record<string, never>, pin?: Pin): Promise<AndroidMachinePreferencesResult>;
  /** Rec: person-only; a partial write keeps the other fields and the SDK folder. */
  setMachinePreferences(args: Partial<AndroidMachinePreferences>, pin?: Pin): Promise<AndroidMachinePreferencesResult>;
  /**
   * Turns a loopback stream URL from another machine into one this renderer
   * can open (the remote loopback forward iOS and Mac Desktop use).
   */
  resolveStreamUrl(
    streamUrl: string | null,
    pin?: Pin,
  ): Promise<{ url: string | null; forwarded: boolean; error: string | null }>;
  onEvent(listener: (event: AndroidEmulatorEvent) => void, pin?: Pin): () => void;
} & AndroidEmulatorLookPreloadApi & AndroidEmulatorSetupPreloadApi & AndroidEmulatorToolsPreloadApi;

export function isAndroidEmulatorErrorCode(value: unknown): value is AndroidEmulatorErrorCode {
  return typeof value === "string" && (ANDROID_EMULATOR_ERROR_CODES as readonly string[]).includes(value);
}

/*
 * The P1 sections live in sibling files, re-exported here so every importer
 * keeps one path: look (`androidEmulatorLook.ts`), setup
 * (`androidEmulatorSetup.ts`), the agent suite (`androidEmulatorAgent.ts`)
 * and the Tools drawer (`androidEmulatorDrawer.ts`).
 */
export * from "./androidEmulatorLook";
export * from "./androidEmulatorSetup";
export * from "./androidEmulatorAgent";
export * from "./androidEmulatorDrawer";
export * from "./androidEmulatorPosture";
export * from "./androidEmulatorImages";
export * from "./androidEmulatorInstrumentation";
export * from "./androidEmulatorPreviews";
export * from "./androidEmulatorRecording";
export * from "./androidEmulatorControl";
export * from "./androidEmulatorDevice";
export * from "./androidEmulatorExtras";

