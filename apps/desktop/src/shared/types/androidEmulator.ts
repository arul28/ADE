/**
 * The Android emulator's shared contract: what the brain reports about the
 * SDK, the AVDs on a machine, the one emulator a lane holds, and the stream
 * and input a viewer uses.
 *
 * Plan: `docs/plans/android-emulator.md`. Emulators only (no physical phones),
 * so a device here is always an AVD that this machine's SDK can boot.
 */

import type { OpenProjectBinding } from "./core";

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
  /** The AVD already runs (one AVD boots once at a time). */
  "ANDROID_AVD_RUNNING",
  "ANDROID_NO_FREE_PORT",
  "ANDROID_BOOT_TIMEOUT",
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
};

export type AndroidDeviceInventory = {
  avds: AndroidAvdListing[];
  profiles: AndroidHardwareProfile[];
  images: AndroidSystemImage[];
};

export type AndroidLaneArgs = { laneId: string };

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
export const ANDROID_ORIENTATIONS: readonly AndroidOrientation[] = ["portrait", "landscape"];
/** Locks the display to this orientation (auto-rotate off). An app that fixes its own orientation keeps it. */
export type AndroidRotateArgs = AndroidLaneArgs & { orientation: AndroidOrientation };
export type AndroidTextArgs = AndroidLaneArgs & { text: string };

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
  | { type: "android.sdk.install"; install: AndroidSdkInstallState }
  /** A recording started or ended; `recording.active` says which. */
  | { type: "android.recording.state"; laneId: string; recording: AndroidRecording }
  | AndroidRenderRequestEvent;

export type AndroidEmulatorServiceApi = {
  getStatus(args?: { laneId?: string | null }): Promise<AndroidEmulatorStatus>;
  listDevices(args?: AndroidListDevicesArgs): Promise<AndroidDeviceInventory>;
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
} & AndroidEmulatorLookServiceApi & AndroidEmulatorAgentServiceApi & AndroidEmulatorSetupServiceApi;

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
  "deviceLease",
  "deviceLeaseRelease",
  "deviceLeaseStatus",
  "setLocation",
  "setAppearance",
  "setPermission",
  "captureProofBundle",
  "getDeviceSettings",
  "setDeviceSetting",
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
] as const;
export type AndroidAgentAction = (typeof ANDROID_AGENT_ACTIONS)[number];

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
  // P1 setup: accepting a licence, writing to disk and the SDK choice are the user's alone.
  "installSdk",
  "cancelSdkInstall",
  "setSdkPath",
] as const;
export type AndroidUserOnlyAction = (typeof ANDROID_USER_ONLY_ACTIONS)[number];

type Pin = OpenProjectBinding | null | undefined;

/** `window.ade.androidEmulator`. Every call takes the optional machine pin last. */
export type AndroidEmulatorPreloadApi = {
  getStatus(args?: { laneId?: string | null }, pin?: Pin): Promise<AndroidEmulatorStatus>;
  listDevices(args?: AndroidListDevicesArgs, pin?: Pin): Promise<AndroidDeviceInventory>;
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
} & AndroidEmulatorLookPreloadApi & AndroidEmulatorSetupPreloadApi & AndroidEmulatorToolsPreloadApi;

/* ──────────────────────────────────────────────────────────────────────────
   P1 LOOK (android-look): the body colour and the 3D render.

   The catalog itself is `shared/androidDeviceCatalog.ts`. A render is drawn
   by a desktop window's 3D view (the brain has no GPU): `requestRender` asks
   every viewer, the first to `renderAck` draws, posts each image to
   `attachRenderProof` (filed to the asking chat's proof drawer), then calls
   `renderComplete`. The same seam as `ade apple render`.
   ────────────────────────────────────────────────────────────────────────── */

export type AndroidSetDeviceColorArgs = AndroidLaneArgs & {
  /** A colour id of the AVD's catalog entry. */
  colorId: string;
};

export const ANDROID_RENDER_ANGLE_IDS = ["front", "three-quarter-left", "three-quarter-right", "back", "current"] as const;
export type AndroidRenderAngleId = (typeof ANDROID_RENDER_ANGLE_IDS)[number];
export const ANDROID_RENDER_BACKGROUNDS = ["transparent", "studio", "dusk"] as const;
export type AndroidRenderBackground = (typeof ANDROID_RENDER_BACKGROUNDS)[number];

export type AndroidRenderRequestSpec = {
  angles: AndroidRenderAngleId[];
  background: AndroidRenderBackground;
  /** A soft contact shadow under the device. */
  shadow: boolean;
  /** Also a turntable video (WebM). */
  video: boolean;
  /** Also one PNG with every still, labelled. */
  contactSheet?: boolean;
};

export type AndroidRenderRequestArgs = AndroidLaneArgs & {
  /** The asking chat, where the proof is filed. Set by the runtime for an agent. */
  chatSessionId?: string | null;
  /** False: write the files but file no proof (a `--machine` caller files them itself). */
  proof?: boolean;
  request: AndroidRenderRequestSpec;
};

export type AndroidRenderRequestResult = {
  filed: number;
  /** The image and video files, on the machine that owns the device. */
  paths: string[];
  proofArtifactIds: string[];
  error: string | null;
};

/** Sent to every viewer of the project; a live 3D pane for the lane takes it. */
export type AndroidRenderRequestEvent = {
  type: "android.render.request";
  laneId: string;
  requestId: string;
  request: AndroidRenderRequestSpec;
};

export type AndroidRenderAckArgs = { requestId: string };
export type AndroidRenderCompleteArgs = { requestId: string; error?: string | null };

export type AndroidAttachRenderProofArgs = AndroidLaneArgs & {
  /** The request this image belongs to; null for a render the user made in the sheet. */
  requestId?: string | null;
  /** `data:image/png;base64,…` or `data:video/webm;base64,…`. */
  dataUrl: string;
  title?: string | null;
};

export type AndroidRenderProofResult = {
  path: string;
  proofArtifactId: string | null;
};

export type AndroidEmulatorLookServiceApi = {
  /** Record a new body colour on the lane's AVD (`ade.color`). */
  setDeviceColor(args: AndroidSetDeviceColorArgs): Promise<AndroidLaneDeviceStatus>;
  requestRender(args: AndroidRenderRequestArgs): Promise<AndroidRenderRequestResult>;
  renderAck(args: AndroidRenderAckArgs): Promise<{ ok: boolean }>;
  renderComplete(args: AndroidRenderCompleteArgs): Promise<{ ok: boolean }>;
  attachRenderProof(args: AndroidAttachRenderProofArgs): Promise<AndroidRenderProofResult>;
};

export type AndroidEmulatorLookPreloadApi = {
  setDeviceColor(args: AndroidSetDeviceColorArgs, pin?: Pin): Promise<AndroidLaneDeviceStatus>;
  renderAck(args: AndroidRenderAckArgs, pin?: Pin): Promise<{ ok: boolean }>;
  renderComplete(args: AndroidRenderCompleteArgs, pin?: Pin): Promise<{ ok: boolean }>;
  attachRenderProof(args: AndroidAttachRenderProofArgs, pin?: Pin): Promise<AndroidRenderProofResult>;
};

/* ──────────────────────────────────────────────────────────────────────────
   P1 SETUP (coordinator): the guided SDK install.

   The setup card reads a plan (what is missing, the sizes, the licences, the
   free disk), the user reads and accepts each licence, and the brain installs
   the parts from Google's repository with no Java. ADE never accepts a licence
   by itself: `installSdk` names every licence id the user accepted, and the
   brain refuses when one is missing. An agent may read the plan, never install.
   ────────────────────────────────────────────────────────────────────────── */

export type AndroidSdkSetupPartId = "platform-tools" | "emulator" | "cmdline-tools" | "system-image" | "android-cli";

export type AndroidSdkSetupPart = {
  id: AndroidSdkSetupPartId;
  /** "Platform tools", "Emulator", "Phone image", … */
  label: string;
  /** The sdkmanager package path, or null for the Android CLI. */
  packagePath: string | null;
  /** The version the install would put in place. */
  version: string | null;
  /** The version already installed, when there is one. */
  installedVersion: string | null;
  /** True when the install would add this part. */
  missing: boolean;
  /** The Android CLI; never needed for a boot. */
  optional: boolean;
  downloadBytes: number;
  /** Disk after unpack (an estimate for the plan). */
  installedBytes: number;
  licenseId: string | null;
  /** One short detail line (`API 36 · Google Play · arm64`). */
  detail: string | null;
};

export type AndroidSdkLicense = {
  id: string;
  /** A readable name ("Android SDK License"). */
  title: string;
  text: string;
  /** The SDK's `licenses/<id>` already holds an acceptance. */
  accepted: boolean;
  /** The parts that need it. */
  partIds: AndroidSdkSetupPartId[];
};

export type AndroidSdkInstallStep = "download" | "verify" | "unpack" | "finish";

export type AndroidSdkInstallState =
  | { state: "idle" }
  | {
    state: "running";
    jobId: string;
    sdkRoot: string;
    startedAt: string;
    step: AndroidSdkInstallStep;
    partId: AndroidSdkSetupPartId;
    partLabel: string;
    partIndex: number;
    partCount: number;
    /** Bytes of this step. */
    bytesDone: number;
    bytesTotal: number;
    /** Download bytes over every part, for the one bar. */
    overallDone: number;
    overallTotal: number;
    etaSeconds: number | null;
    cancelling: boolean;
  }
  | { state: "done"; jobId: string; sdkRoot: string; finishedAt: string; installed: AndroidSdkSetupPartId[] }
  | {
    state: "failed";
    jobId: string;
    sdkRoot: string;
    finishedAt: string;
    partId: AndroidSdkSetupPartId | null;
    error: { code: AndroidErrorCode; message: string };
    installed: AndroidSdkSetupPartId[];
  }
  | { state: "cancelled"; jobId: string; sdkRoot: string; finishedAt: string; installed: AndroidSdkSetupPartId[] };

export type AndroidSdkSetupPlan = {
  /** False when Google publishes no emulator for this host (Windows on Arm, other OSes). */
  hostSupported: boolean;
  unsupportedReason: string | null;
  /** Where the install goes: the found SDK, the folder the user chose, or the platform default. */
  sdkRoot: string;
  sdkRootSource: "found" | "chosen" | "default";
  /** The SDK already in the install folder, when there is one. */
  existingSdkRoot: string | null;
  parts: AndroidSdkSetupPart[];
  licenses: AndroidSdkLicense[];
  /** Download and disk totals for the parts that are missing (and the CLI, when asked). */
  downloadBytes: number;
  diskBytesNeeded: number;
  diskBytesFree: number | null;
  /** The install folder can be made and written. */
  writable: boolean;
  writableDetail: string | null;
  /** Where new devices go, and its free space (each device takes several GB). */
  avdHome: string | null;
  avdHomeFreeBytes: number | null;
  acceleration: AndroidAcceleration;
  /** Set when Google's repository could not be read; the parts then carry no versions or sizes. */
  repositoryError: string | null;
  install: AndroidSdkInstallState;
  checkedAt: string;
};

export type AndroidSdkSetupArgs = {
  /** The install folder the user picked with the pencil; omitted = the plan's own choice. */
  sdkRoot?: string | null;
  /** Add the optional Android CLI. */
  includeAndroidCli?: boolean;
};

export type AndroidSdkInstallArgs = AndroidSdkSetupArgs & {
  /** Every licence id the user read and accepted in this request. */
  acceptedLicenseIds: string[];
};

export type AndroidSetSdkPathArgs = {
  /** An existing SDK folder ("Use mine…"), or null to go back to detection. */
  path: string | null;
};

export type AndroidEmulatorSetupServiceApi = {
  getSdkSetupPlan(args?: AndroidSdkSetupArgs): Promise<AndroidSdkSetupPlan>;
  /** Starts the install and returns at once; progress comes as `android.sdk.install` events. */
  installSdk(args: AndroidSdkInstallArgs): Promise<AndroidSdkInstallState>;
  cancelSdkInstall(): Promise<AndroidSdkInstallState>;
  getSdkInstallState(): Promise<AndroidSdkInstallState>;
  setSdkPath(args: AndroidSetSdkPathArgs): Promise<AndroidEmulatorStatus>;
};

export type AndroidEmulatorSetupPreloadApi = {
  getSdkSetupPlan(args?: AndroidSdkSetupArgs, pin?: Pin): Promise<AndroidSdkSetupPlan>;
  installSdk(args: AndroidSdkInstallArgs, pin?: Pin): Promise<AndroidSdkInstallState>;
  cancelSdkInstall(args?: Record<string, never>, pin?: Pin): Promise<AndroidSdkInstallState>;
  getSdkInstallState(args?: Record<string, never>, pin?: Pin): Promise<AndroidSdkInstallState>;
  setSdkPath(args: AndroidSetSdkPathArgs, pin?: Pin): Promise<AndroidEmulatorStatus>;
};

/* ──────────────────────────────────────────────────────────────────────────
   P1 AGENT SUITE (android-agent): `ade android` at the level of `ade apple`.

   Apps (install with an APK or Gradle, launch, terminate, uninstall), the
   input verbs Apple has (long press, drag, scroll), the UI tree and element
   verbs, logcat, recordings and proof, the lease, and three cheap emulator
   controls. Every point is in device pixels, the same pixels as a screenshot.
   Plan §3.5 and §6 P1 "Agent".
   ────────────────────────────────────────────────────────────────────────── */

/** Refusals the agent verbs add. Kept apart from the panel's codes, which the pane maps to sentences. */
export const ANDROID_AGENT_ERROR_CODES = [
  /** No element on screen matches the query. */
  "ANDROID_ELEMENT_NOT_FOUND",
  /** `wait-for-element` ran out of time. */
  "ANDROID_WAIT_TIMEOUT",
  /** The UI tree could not be read (a secure screen, an animation that never settles). */
  "ANDROID_UI_TREE_FAILED",
  /** No such package on the device, or it has no launcher activity. */
  "ANDROID_APP_NOT_FOUND",
  /** The Gradle build or its install task failed. */
  "ANDROID_BUILD_FAILED",
  /** `adb install` refused the APK. */
  "ANDROID_INSTALL_FAILED",
  /** An uninstall on an AVD the lane attached, of a package ADE did not install there. */
  "ANDROID_PACKAGE_NOT_ADE_INSTALLED",
  /** A recording already runs for this lane. */
  "ANDROID_RECORDING_ACTIVE",
  /** No recording runs (stop), or none has that id (delete). */
  "ANDROID_RECORDING_NOT_FOUND",
] as const;
export type AndroidAgentErrorCode = (typeof ANDROID_AGENT_ERROR_CODES)[number];
/** Every code the backend refuses with. */
export type AndroidErrorCode = AndroidEmulatorErrorCode | AndroidAgentErrorCode;

export function isAndroidEmulatorErrorCode(value: unknown): value is AndroidEmulatorErrorCode {
  return typeof value === "string" && (ANDROID_EMULATOR_ERROR_CODES as readonly string[]).includes(value);
}

/** Where the UI tree comes from: `uiautomator dump` on the device, or Google's Android CLI (`android layout`). */
export type AndroidUiTreeSource = "uiautomator" | "android-cli";

/** What this machine can do now, in `status`. Read on use, like the SDK. */
export type AndroidCapabilities = {
  /** adb is here: input, screenshots, apps, logcat, the UI tree, emulator controls. */
  adb: boolean;
  /** The live view: adb and the bundled scrcpy server. */
  stream: boolean;
  /** Recordings ride on the scrcpy stream, so they need the same. */
  record: boolean;
  /** The UI tree source `snapshot` uses, or null without adb. */
  uiTree: AndroidUiTreeSource | null;
  logcat: boolean;
  /**
   * A Gradle build can run: adb and a JDK (`jdk`). Gradle itself comes from
   * the project's wrapper (`gradlew`, `gradlew.bat`).
   */
  gradle: boolean;
  /**
   * The JDK ADE gives Gradle as JAVA_HOME: JAVA_HOME, Android Studio's
   * bundled JDK, `/usr/libexec/java_home`, Homebrew, or `java` on the PATH.
   * Null when none is found.
   */
  jdk?: { home: string; source: string; version: string | null } | null;
  /** Google's Android CLI, when installed. ADE always runs it with `--no-metrics`. */
  androidCli: { path: string; version: string | null } | null;
};

/* ---------- apps ---------- */

export type AndroidAppInfo = {
  packageName: string;
  /** `package/.Activity` the launcher starts, or null when it has none. */
  launchActivity: string | null;
  /** ADE installed it on this lane's AVD (`adeInstalledPackages`). */
  adeInstalled: boolean;
};

export type AndroidAppList = { laneId: string; apps: AndroidAppInfo[] };

/** A Gradle build in the lane's worktree: `gradlew :<module>:install<Variant>`. */
export type AndroidGradleTarget = {
  /** Default `app`. */
  module?: string | null;
  /** Default `debug`. */
  variant?: string | null;
};

export type AndroidInstallArgs = AndroidLaneArgs & {
  /** An APK inside the lane's worktree. One of `apkPath` and `gradle`. */
  apkPath?: string | null;
  gradle?: AndroidGradleTarget | null;
};

export type AndroidInstallResult = {
  laneId: string;
  /** The installed package, when ADE could read it. */
  packageName: string | null;
  method: "apk" | "gradle";
  /** The APK that was installed (the build's output for Gradle), when known. */
  apkPath: string | null;
  /** `:app:installDebug`, for Gradle. */
  gradleTask: string | null;
  durationMs: number;
  /** The last lines of the build or install output. */
  outputTail: string[];
};

export type AndroidLaunchArgs = AndroidInstallArgs & {
  /** An installed package to start; with `apkPath` or `gradle` the installed one is used. */
  packageName?: string | null;
  /** `.MainActivity` or `com.example/.MainActivity`; default = the launcher activity. */
  activity?: string | null;
};

export type AndroidLaunchResult = {
  laneId: string;
  packageName: string;
  /** The component that was started (`com.example/.MainActivity`). */
  activity: string;
  /** Set when the launch installed first. */
  install: AndroidInstallResult | null;
  /** From `am start -W`, when the device reports it. */
  totalTimeMs: number | null;
};

export type AndroidPackageArgs = AndroidLaneArgs & { packageName: string };

export type AndroidOpenUrlArgs = AndroidLaneArgs & { url: string };

/* ---------- input ---------- */

/** How long a long press holds when the caller names no duration, and its bounds (as Apple's). */
export const ANDROID_LONG_PRESS_DEFAULT_MS = 1_000;
export const ANDROID_LONG_PRESS_MIN_MS = 100;
export const ANDROID_LONG_PRESS_MAX_MS = 5_000;

export type AndroidLongPressArgs = AndroidLaneArgs & { x: number; y: number; durationMs?: number | null };

/**
 * A press that holds before it moves: drag and drop, reorder. A swipe moves
 * at once (a fling, a scroll).
 */
export type AndroidDragArgs = AndroidSwipeArgs;

export const ANDROID_SCROLL_DIRECTIONS = ["up", "down", "left", "right"] as const;
export type AndroidScrollDirection = (typeof ANDROID_SCROLL_DIRECTIONS)[number];

export type AndroidScrollArgs = AndroidLaneArgs & {
  /** The way the content moves: `down` shows what is below. */
  direction: AndroidScrollDirection;
  /** Distance in device pixels; default half the screen. */
  amount?: number | null;
  /** Where the finger starts; default the screen's centre. */
  anchorX?: number | null;
  anchorY?: number | null;
};

/* ---------- UI tree ---------- */

/** A box in device pixels. */
export type AndroidUiBounds = { x: number; y: number; width: number; height: number };

export type AndroidUiElement = {
  /**
   * Stable between snapshots: built from the resource id, else the content
   * description, else the text, with `#2`, `#3` for repeats. `tap-element
   * --ref` takes it.
   */
  ref: string;
  /** The tree position (`0.1.2`); moves with the layout. */
  path: string;
  /** `com.example:id/submit`. */
  resourceId: string | null;
  /** The resource id without its package (`submit`): `--identifier` matches it. */
  identifier: string | null;
  /** `content-desc`: `--label` matches it. */
  label: string | null;
  text: string | null;
  /** The class's short name (`Button`, `EditText`): `--role` matches it. */
  role: string | null;
  className: string | null;
  packageName: string | null;
  bounds: AndroidUiBounds;
  /** Where `tap-element` taps. */
  center: { x: number; y: number };
  clickable: boolean;
  longClickable: boolean;
  scrollable: boolean;
  focusable: boolean;
  focused: boolean;
  enabled: boolean;
  checked: boolean | null;
  selected: boolean;
  password: boolean;
};

export type AndroidUiSnapshot = {
  laneId: string;
  source: AndroidUiTreeSource;
  capturedAt: string;
  /** The read's own cost; near 0 for a cached answer. */
  durationMs: number;
  /** Served from the per-screen cache (no input since, the same window). */
  cached: boolean;
  /** The screen in device pixels, in its current orientation, when known. */
  width: number | null;
  height: number | null;
  /** The app in front, when known. */
  foregroundPackage: string | null;
  elements: AndroidUiElement[];
};

/** The same query shape as `ade apple`. */
export type AndroidElementQuery = {
  ref?: string | null;
  /** The resource id, with or without its package. */
  identifier?: string | null;
  /** The content description, case-insensitive; a prefix when nothing matches exactly. */
  label?: string | null;
  /** A case-insensitive substring of the text or the content description. */
  text?: string | null;
  /** The class's short name, case-insensitive (`Button`, `EditText`). */
  role?: string | null;
  /** Which match to take when several match (0-based). */
  index?: number | null;
};

export type AndroidElementQueryArgs = AndroidLaneArgs & { query: AndroidElementQuery };

export type AndroidTapElementArgs = AndroidElementQueryArgs & {
  /** Hold the press this long: a long press on the element. */
  holdMs?: number | null;
};

export type AndroidFillElementArgs = AndroidElementQueryArgs & {
  text: string;
  /** Tap the field first so the keyboard targets it. Default true. */
  focusFirst?: boolean | null;
};

export type AndroidWaitForElementArgs = AndroidElementQueryArgs & {
  /** Default 5000, at most 60000. */
  timeoutMs?: number | null;
  /** Default `visible`. */
  state?: "visible" | "gone" | null;
};

export type AndroidElementMatch = {
  ref: string;
  element: AndroidUiElement;
  matchCount: number;
  /** Set when the query matched another way than it said (a label prefix). */
  note?: string | null;
};

export type AndroidElementActionResult = {
  ok: boolean;
  action: "find" | "tap" | "fill" | "wait" | "assert";
  match: AndroidElementMatch | null;
  matchCount: number;
  /** The other matches, so the next call can name `--index`. At most 10. */
  others: Array<{ index: number; ref: string; center: { x: number; y: number } }>;
  message: string | null;
  waitedMs: number | null;
  /** `fill-element` only: the field read back after typing. */
  typed?: "verified" | "not-seen" | "unknown";
  typedDetail?: string | null;
};

/* ---------- logcat ---------- */

export const ANDROID_LOG_LEVELS = ["verbose", "debug", "info", "warn", "error", "fatal"] as const;
export type AndroidLogLevel = (typeof ANDROID_LOG_LEVELS)[number];

export type AndroidLogArgs = AndroidLaneArgs & {
  /** Only this app's lines (its running pids, else its uid). */
  packageName?: string | null;
  /** The lowest level to keep. Default `verbose`. */
  level?: AndroidLogLevel | null;
  /** Only lines after this cursor (the `cursor` of an earlier read, epoch seconds `1730000000.123`). */
  since?: string | null;
  /** The newest lines to return. Default 200, at most 2000. */
  lines?: number | null;
};

export type AndroidLogLine = {
  /** Epoch seconds with milliseconds, as logcat prints them (`1730000000.123`). */
  time: string;
  pid: number;
  tid: number;
  level: "V" | "D" | "I" | "W" | "E" | "F" | "S";
  tag: string;
  message: string;
};

export type AndroidLogResult = {
  laneId: string;
  packageName: string | null;
  /** The app's pids the read filtered on; empty when it filtered by uid or not at all. */
  pids: number[];
  lines: AndroidLogLine[];
  /** More lines matched than `lines` returned. */
  truncated: boolean;
  /** Pass back as `since` to read only newer lines. */
  cursor: string | null;
};

/* ---------- recordings ---------- */

/**
 * One file of a recording. A rotation changes the picture's size, and one MP4
 * track keeps one size, so a rotation starts a new segment.
 */
export type AndroidRecordingSegment = {
  path: string;
  width: number;
  height: number;
  durationMs: number;
  bytes: number;
  frames: number;
};

export type AndroidRecordingStopReason = "requested" | "cap" | "device-off" | "stream-failed" | "released" | "chat-ended";

export type AndroidRecording = {
  id: string;
  laneId: string;
  /** The chat that started it; the proof is filed to it. */
  chatSessionId: string | null;
  label: string | null;
  /** The first segment's MP4. */
  path: string;
  segments: AndroidRecordingSegment[];
  startedAt: string;
  endedAt: string | null;
  durationMs: number | null;
  bytes: number | null;
  active: boolean;
  stopReason: AndroidRecordingStopReason | null;
  /** One per segment that was filed. */
  proofArtifactIds: string[];
  /** Why it holds no video, when it does not. */
  lastError: string | null;
};

/** No recording runs longer than this (Apple's cap); `maxSeconds` may ask for less. */
export const ANDROID_RECORDING_MAX_SECONDS = 300;

export type AndroidRecordStartArgs = AndroidLaneArgs & {
  chatSessionId?: string | null;
  label?: string | null;
  maxSeconds?: number | null;
};

export type AndroidRecordStopArgs = AndroidLaneArgs & {
  chatSessionId?: string | null;
  /** Delete the video instead of keeping and filing it. */
  discard?: boolean;
  /** False = keep the files but file no proof (a `--machine` caller files them itself). */
  proof?: boolean;
};

export type AndroidRecordDeleteArgs = AndroidLaneArgs & { id: string };

/* ---------- lease ---------- */

export type AndroidLeaseArgs = AndroidLaneArgs & {
  /** Set by the runtime for an agent. */
  chatSessionId?: string | null;
  holder?: string | null;
  ttlMs?: number | null;
  waitMs?: number | null;
  token?: string | null;
  /** Only the token renews (every current CLI). */
  distinct?: boolean | null;
};

export type AndroidLeaseHolder = { holder: string; acquiredAt: string; expiresAt: string };

/** The same answer shape as `ade apple lease`, with the lane's AVD as the device. */
export type AndroidLeaseAnswer =
  | (AndroidLeaseHolder & { acquired: true; renewed: boolean; waitedMs: number; token: string | null; device: { avdName: string | null } })
  | { acquired: false; current: AndroidLeaseHolder | null; queued: number; sameHolder?: boolean; device: { avdName: string | null } };

export type AndroidLeaseReleaseArgs = AndroidLaneArgs & { token: string; chatSessionId?: string | null };
export type AndroidLeaseStatus = { held: boolean; current: AndroidLeaseHolder | null; queued: number; device: { avdName: string | null } };

/* ---------- emulator controls ---------- */

export type AndroidLocationArgs = AndroidLaneArgs & { latitude: number; longitude: number };
export type AndroidAppearanceArgs = AndroidLaneArgs & { appearance: "light" | "dark" };
export type AndroidPermissionArgs = AndroidLaneArgs & {
  action: "grant" | "revoke";
  packageName: string;
  /** `android.permission.CAMERA`, or the short `camera`. */
  permission: string;
};

/* ---------- proof bundle ---------- */

export type AndroidProofBundleArgs = AndroidLaneArgs & {
  chatSessionId?: string | null;
  /** A folder inside the lane's worktree; default under ADE's data folder. */
  outDir?: string | null;
  caption?: string | null;
  /** Default true. */
  includeElements?: boolean | null;
  /** Logcat lines to include (default 200; 0 for none). */
  logLines?: number | null;
  /** Only this app's log lines. */
  packageName?: string | null;
  proof?: boolean;
};

export type AndroidProofBundle = {
  dir: string;
  screenshotPath: string;
  elementsPath: string | null;
  logPath: string | null;
  metaPath: string;
  width: number;
  height: number;
  capturedAt: string;
  proofArtifactId: string | null;
};

export type AndroidEmulatorAgentServiceApi = {
  listApps(args: AndroidLaneArgs): Promise<AndroidAppList>;
  /** A Gradle install can take minutes: the action has a long timeout. */
  installApp(args: AndroidInstallArgs): Promise<AndroidInstallResult>;
  launchApp(args: AndroidLaunchArgs): Promise<AndroidLaunchResult>;
  terminateApp(args: AndroidPackageArgs): Promise<{ laneId: string; packageName: string }>;
  /** On an attached AVD, only a package ADE installed (`ANDROID_PACKAGE_NOT_ADE_INSTALLED`). */
  uninstallApp(args: AndroidPackageArgs): Promise<{ laneId: string; packageName: string; uninstalled: boolean }>;
  openUrl(args: AndroidOpenUrlArgs): Promise<{ laneId: string; url: string }>;
  longPress(args: AndroidLongPressArgs): Promise<void>;
  drag(args: AndroidDragArgs): Promise<void>;
  scroll(args: AndroidScrollArgs): Promise<void>;
  getScreenSnapshot(args: AndroidLaneArgs & { fresh?: boolean | null }): Promise<AndroidUiSnapshot>;
  findElement(args: AndroidElementQueryArgs): Promise<AndroidElementActionResult>;
  tapElement(args: AndroidTapElementArgs): Promise<AndroidElementActionResult>;
  fillElement(args: AndroidFillElementArgs): Promise<AndroidElementActionResult>;
  waitForElement(args: AndroidWaitForElementArgs): Promise<AndroidElementActionResult>;
  assertVisible(args: AndroidElementQueryArgs): Promise<AndroidElementActionResult>;
  /** A bounded read (`logcat -d`). P2's Logs drawer streams with the same parser. */
  readLog(args: AndroidLogArgs): Promise<AndroidLogResult>;
  recordStart(args: AndroidRecordStartArgs): Promise<AndroidRecording>;
  /** Files the video in the starting chat's proof drawer unless `discard` or `proof: false`. */
  recordStop(args: AndroidRecordStopArgs): Promise<AndroidRecording>;
  recordList(args: AndroidLaneArgs): Promise<{ laneId: string; recordings: AndroidRecording[] }>;
  recordDelete(args: AndroidRecordDeleteArgs): Promise<{ laneId: string; id: string; deleted: boolean }>;
  deviceLease(args: AndroidLeaseArgs): Promise<AndroidLeaseAnswer>;
  deviceLeaseRelease(args: AndroidLeaseReleaseArgs): Promise<{ released: boolean; reason?: string | null; device: { avdName: string | null } | null }>;
  deviceLeaseStatus(args: AndroidLaneArgs): Promise<AndroidLeaseStatus>;
  setLocation(args: AndroidLocationArgs): Promise<{ laneId: string; latitude: number; longitude: number }>;
  setAppearance(args: AndroidAppearanceArgs): Promise<{ laneId: string; appearance: "light" | "dark" }>;
  setPermission(args: AndroidPermissionArgs): Promise<{ laneId: string; action: "grant" | "revoke"; packageName: string; permission: string }>;
  captureProofBundle(args: AndroidProofBundleArgs): Promise<AndroidProofBundle>;
  /** The Tools drawer's device settings, read in one device shell. */
  getDeviceSettings(args: AndroidDeviceSettingsArgs): Promise<AndroidDeviceSettings>;
  /** Changes one setting and answers with the settings read after it. */
  setDeviceSetting(args: AndroidSetDeviceSettingArgs): Promise<AndroidDeviceSettings>;
  /**
   * A chat ended: its leases pass on and its recording stops (and is filed).
   * Not an action.
   */
  releaseIfOwnedBy(chatSessionId: string): Promise<void>;
};

/* ---------- the Tools drawer's device settings ---------- */

/** Android's text sizes as `font_scale`: 0.85, 1, 1.15, 1.3. */
export type AndroidTextSize = "small" | "default" | "large" | "largest";
/** Android's display sizes as a density scale: 0.85, 1, 1.15, 1.3. */
export type AndroidDisplaySize = "small" | "default" | "large" | "larger";

/** What the lane's emulator reports now. A value the image does not report is null. */
export type AndroidDeviceSettings = {
  laneId: string;
  appearance: "light" | "dark" | null;
  fontScale: number | null;
  /** Null when `fontScale` is not one of the four sizes. */
  textSize: AndroidTextSize | null;
  density: { physical: number | null; override: number | null };
  displaySize: AndroidDisplaySize | null;
  animationsOff: boolean | null;
  showTaps: boolean | null;
  layoutBounds: boolean | null;
  battery: { level: number | null; charging: boolean | null };
  network: { wifi: boolean | null; mobileData: boolean | null; airplane: boolean | null };
  /** The app in front; null on the home screen. */
  foregroundPackage: string | null;
};

export type AndroidDeviceSetting =
  | { kind: "text-size"; value: AndroidTextSize }
  | { kind: "display-size"; value: AndroidDisplaySize }
  | { kind: "animations"; off: boolean }
  | { kind: "show-taps"; on: boolean }
  | { kind: "layout-bounds"; on: boolean }
  | { kind: "battery"; level?: number | null; charging?: boolean | null }
  | { kind: "wifi"; on: boolean }
  | { kind: "mobile-data"; on: boolean }
  | { kind: "airplane"; on: boolean };

export type AndroidDeviceSettingsArgs = AndroidLaneArgs & {
  /** `foreground` reads only the app in front (the App group's poll). Default `all`. */
  fields?: "all" | "foreground" | null;
};

export type AndroidSetDeviceSettingArgs = AndroidLaneArgs & { setting: AndroidDeviceSetting };

/**
 * The agent verbs a desktop window calls: the Tools drawer, Inspect and
 * Record. Runtime-only routes (no IPC channel), as App Control's: the pane
 * exists only in a project, and the project's runtime owns the emulator.
 */
export type AndroidEmulatorToolsPreloadApi = {
  listApps(args: AndroidLaneArgs, pin?: Pin): Promise<AndroidAppList>;
  installApp(args: AndroidInstallArgs, pin?: Pin): Promise<AndroidInstallResult>;
  launchApp(args: AndroidLaunchArgs, pin?: Pin): Promise<AndroidLaunchResult>;
  terminateApp(args: AndroidPackageArgs, pin?: Pin): Promise<{ laneId: string; packageName: string }>;
  uninstallApp(args: AndroidPackageArgs, pin?: Pin): Promise<{ laneId: string; packageName: string; uninstalled: boolean }>;
  openUrl(args: AndroidOpenUrlArgs, pin?: Pin): Promise<{ laneId: string; url: string }>;
  getScreenSnapshot(args: AndroidLaneArgs & { fresh?: boolean | null }, pin?: Pin): Promise<AndroidUiSnapshot>;
  recordStart(args: AndroidRecordStartArgs, pin?: Pin): Promise<AndroidRecording>;
  recordStop(args: AndroidRecordStopArgs, pin?: Pin): Promise<AndroidRecording>;
  recordList(args: AndroidLaneArgs, pin?: Pin): Promise<{ laneId: string; recordings: AndroidRecording[] }>;
  recordDelete(args: AndroidRecordDeleteArgs, pin?: Pin): Promise<{ laneId: string; id: string; deleted: boolean }>;
  setLocation(args: AndroidLocationArgs, pin?: Pin): Promise<{ laneId: string; latitude: number; longitude: number }>;
  setAppearance(args: AndroidAppearanceArgs, pin?: Pin): Promise<{ laneId: string; appearance: "light" | "dark" }>;
  setPermission(args: AndroidPermissionArgs, pin?: Pin): Promise<{ laneId: string; action: "grant" | "revoke"; packageName: string; permission: string }>;
  getDeviceSettings(args: AndroidDeviceSettingsArgs, pin?: Pin): Promise<AndroidDeviceSettings>;
  setDeviceSetting(args: AndroidSetDeviceSettingArgs, pin?: Pin): Promise<AndroidDeviceSettings>;
};
