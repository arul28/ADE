/**
 * The Android emulator's shared contract: what the brain reports about the
 * SDK, the AVDs on a machine, the one emulator a lane holds, and the stream
 * and input a viewer uses.
 *
 * Plan: `docs/plans/android-emulator.md`. Emulators only (no physical phones),
 * so a device here is always an AVD that this machine's SDK can boot.
 */

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
  /** The AVD folder (`<avdHome>/<name>.avd`). */
  path: string;
  /** Bytes on disk, when measured. */
  sizeBytes: number | null;
  /** ADE created this AVD (it carries ADE's marker in `config.ini`). */
  adeCreated: boolean;
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
};

/** The emulator the lane holds, as the panel reads it. */
export type AndroidLaneDeviceStatus = {
  laneId: string;
  device: AndroidLaneDevice | null;
  avd: AndroidAvd | null;
  state: "none" | "off" | "starting" | "booted" | "stopping" | "crashed";
  /** Set when `state` is `crashed` or a start failed. */
  error: AndroidEmulatorError | null;
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

export const ANDROID_EMULATOR_ERROR_CODES = [
  "ANDROID_SDK_NOT_FOUND",
  "ANDROID_TOOL_MISSING",
  "ANDROID_NO_ACCELERATION",
  "ANDROID_NO_SYSTEM_IMAGE",
  "ANDROID_AVD_NOT_FOUND",
  "ANDROID_AVD_HELD_BY_OTHER_LANE",
  /** The lane already holds an AVD; release it before making or attaching another. */
  "ANDROID_LANE_HAS_DEVICE",
  /** The AVD already runs (one AVD boots once at a time). */
  "ANDROID_AVD_RUNNING",
  "ANDROID_NO_FREE_PORT",
  "ANDROID_BOOT_TIMEOUT",
  "ANDROID_EMULATOR_EXITED",
  "ANDROID_STREAM_FAILED",
  "ANDROID_NOT_RUNNING",
  /** A screenshot `outPath` that resolves outside the lane's worktree. */
  "ANDROID_PATH_OUTSIDE_LANE",
] as const;
export type AndroidEmulatorErrorCode = (typeof ANDROID_EMULATOR_ERROR_CODES)[number];

export type AndroidEmulatorError = {
  code: AndroidEmulatorErrorCode;
  /** One plain sentence for the panel. */
  message: string;
  /** The emulator log path, when there is one ("Open log"). */
  logPath?: string | null;
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
};

export type AndroidDeviceInventory = {
  avds: AndroidAvdListing[];
  profiles: AndroidHardwareProfile[];
  images: AndroidSystemImage[];
};

export type AndroidLaneArgs = { laneId: string };

export type AndroidCreateDeviceArgs = AndroidLaneArgs & {
  profileId: string;
  /** A system image package id; omitted = the newest installed image for the host ABI. */
  systemImage?: string | null;
  displayName?: string | null;
  /** Boot it right after create (the panel's one-click create). Default true. */
  start?: boolean;
};

export type AndroidAttachDeviceArgs = AndroidLaneArgs & {
  avdName: string;
  /** Boot it right after attach. Default true. */
  start?: boolean;
};

export type AndroidReleaseDeviceArgs = AndroidLaneArgs & {
  /**
   * For an AVD ADE created: delete it (default true). An attached user AVD is
   * never deleted; ADE only uninstalls the packages it installed.
   */
  deleteCreated?: boolean;
};

export type AndroidStartStreamArgs = AndroidLaneArgs & {
  /** Long side of the video in pixels. Default from the stream defaults. */
  maxSize?: number | null;
  bitRateBps?: number | null;
  maxFps?: number | null;
};

export type AndroidTouchArgs = AndroidLaneArgs & { events: AndroidTouchEvent[] };
export type AndroidTapArgs = AndroidLaneArgs & { x: number; y: number };
export type AndroidSwipeArgs = AndroidLaneArgs & {
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
  durationMs?: number | null;
};
export type AndroidKeyArgs = AndroidLaneArgs & { key: AndroidHardwareKey };
export type AndroidOrientation = "portrait" | "landscape";
/** Locks the display to this orientation (auto-rotate off). An app that fixes its own orientation keeps it. */
export type AndroidRotateArgs = AndroidLaneArgs & { orientation: AndroidOrientation };
export type AndroidTextArgs = AndroidLaneArgs & { text: string };

export type AndroidScreenshotArgs = AndroidLaneArgs & {
  /** Absolute path to write the PNG to; omitted = a file under the ADE data folder. */
  outPath?: string | null;
};

export type AndroidScreenshot = {
  path: string;
  width: number;
  height: number;
  bytes: number;
  capturedAt: string;
};

/** Pushed to every viewer; the renderer re-reads status on these. */
export type AndroidEmulatorEvent =
  | { type: "android.device.state"; laneId: string; state: AndroidLaneDeviceStatus["state"] }
  | { type: "android.stream.state"; laneId: string; running: boolean }
  | { type: "android.inventory.changed" }
  | { type: "android.sdk.changed" };

export type AndroidEmulatorServiceApi = {
  getStatus(args?: { laneId?: string | null }): Promise<AndroidEmulatorStatus>;
  listDevices(args?: { laneId?: string | null }): Promise<AndroidDeviceInventory>;
  /** Make a new AVD for the lane from a profile and hold it. */
  createDevice(args: AndroidCreateDeviceArgs): Promise<AndroidLaneDeviceStatus>;
  /** Hold an existing (user or free ADE) AVD for the lane. */
  attachDevice(args: AndroidAttachDeviceArgs): Promise<AndroidLaneDeviceStatus>;
  /** Boot the lane's AVD (no-op when already booted). */
  start(args: AndroidLaneArgs): Promise<AndroidLaneDeviceStatus>;
  /** Stop the lane's emulator if ADE started it. */
  stop(args: AndroidLaneArgs): Promise<AndroidLaneDeviceStatus>;
  releaseDevice(args: AndroidReleaseDeviceArgs): Promise<{ released: boolean; deletedAvd: string | null }>;
  /** Delete an ADE-created AVD that no lane holds. User-only. */
  deleteDevice(args: { avdName: string }): Promise<{ deleted: boolean }>;
  /** Mints the loopback stream token: viewers only, never a session-bound agent. */
  startStream(args: AndroidStartStreamArgs): Promise<AndroidStreamStatus>;
  stopStream(args: AndroidLaneArgs): Promise<AndroidStreamStatus>;
  /** Redacted: `transport` is always null here. */
  getStreamStatus(args: AndroidLaneArgs): Promise<AndroidStreamStatus>;
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
   * emulator ADE started is stopped too. Not an action.
   */
  dispose(): Promise<void>;
  onEvent(listener: (event: AndroidEmulatorEvent) => void): () => void;
};

/** Actions an agent may call (a session-bound agent, through the action bus and `ade android`). */
export const ANDROID_AGENT_ACTIONS = [
  "getStatus",
  "listDevices",
  "createDevice",
  "attachDevice",
  "start",
  "stop",
  "releaseDevice",
  "getStreamStatus",
  "tap",
  "swipe",
  "sendKey",
  "sendText",
  "rotate",
  "screenshot",
] as const;
export type AndroidAgentAction = (typeof ANDROID_AGENT_ACTIONS)[number];

/** Actions only a viewing client (desktop, web, phone at cto role) may call. */
export const ANDROID_USER_ONLY_ACTIONS = ["startStream", "stopStream", "sendTouch", "deleteDevice"] as const;
export type AndroidUserOnlyAction = (typeof ANDROID_USER_ONLY_ACTIONS)[number];

type Pin = import("./core").OpenProjectBinding | null | undefined;

/** `window.ade.androidEmulator`. Every call takes the optional machine pin last. */
export type AndroidEmulatorPreloadApi = {
  getStatus(args?: { laneId?: string | null }, pin?: Pin): Promise<AndroidEmulatorStatus>;
  listDevices(args?: { laneId?: string | null }, pin?: Pin): Promise<AndroidDeviceInventory>;
  createDevice(args: AndroidCreateDeviceArgs, pin?: Pin): Promise<AndroidLaneDeviceStatus>;
  attachDevice(args: AndroidAttachDeviceArgs, pin?: Pin): Promise<AndroidLaneDeviceStatus>;
  start(args: AndroidLaneArgs, pin?: Pin): Promise<AndroidLaneDeviceStatus>;
  stop(args: AndroidLaneArgs, pin?: Pin): Promise<AndroidLaneDeviceStatus>;
  releaseDevice(args: AndroidReleaseDeviceArgs, pin?: Pin): Promise<{ released: boolean; deletedAvd: string | null }>;
  deleteDevice(args: { avdName: string }, pin?: Pin): Promise<{ deleted: boolean }>;
  startStream(args: AndroidStartStreamArgs, pin?: Pin): Promise<AndroidStreamStatus>;
  stopStream(args: AndroidLaneArgs, pin?: Pin): Promise<AndroidStreamStatus>;
  getStreamStatus(args: AndroidLaneArgs, pin?: Pin): Promise<AndroidStreamStatus>;
  sendTouch(args: AndroidTouchArgs, pin?: Pin): Promise<void>;
  sendKey(args: AndroidKeyArgs, pin?: Pin): Promise<void>;
  sendText(args: AndroidTextArgs, pin?: Pin): Promise<void>;
  rotate(args: AndroidRotateArgs, pin?: Pin): Promise<void>;
  screenshot(args: AndroidScreenshotArgs, pin?: Pin): Promise<AndroidScreenshot>;
  /**
   * Turns a loopback stream URL from another machine into one this renderer
   * can open (the remote loopback forward iOS and Mac Desktop use).
   */
  resolveStreamUrl(
    streamUrl: string | null,
    pin?: Pin,
  ): Promise<{ url: string | null; forwarded: boolean; error: string | null }>;
  onEvent(listener: (event: AndroidEmulatorEvent) => void, pin?: Pin): () => void;
};
