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
  /** The AVD already runs (one AVD boots once at a time). */
  "ANDROID_AVD_RUNNING",
  "ANDROID_NO_FREE_PORT",
  "ANDROID_BOOT_TIMEOUT",
  "ANDROID_EMULATOR_EXITED",
  "ANDROID_STREAM_FAILED",
  "ANDROID_NOT_RUNNING",
] as const;
export type AndroidEmulatorErrorCode = (typeof ANDROID_EMULATOR_ERROR_CODES)[number];

export type AndroidEmulatorError = {
  code: AndroidEmulatorErrorCode;
  /** One plain sentence for the panel. */
  message: string;
  /** The emulator log path, when there is one ("Open log"). */
  logPath?: string | null;
};
