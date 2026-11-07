/**
 * The Android emulator contract, P1 agent suite: `ade android` at the level
 * of `ade apple`. Re-exported from `androidEmulator.ts`; import from there.
 */

import type {
  AndroidDeviceSettings,
  AndroidDeviceSettingsArgs,
  AndroidEmulatorErrorCode,
  AndroidLaneArgs,
  AndroidSetDeviceSettingArgs,
  AndroidSwipeArgs,
} from "./androidEmulator";
import type { DemoArtifactMetadata } from "../demoVideo/demoContract";
import type { AndroidLaunchExtrasArgs } from "./androidEmulatorControl";
import type { AndroidInputRecordArgs } from "./androidEmulatorRecording";

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
  /** P3: AVDs use the system image (a removal the person did not confirm), or one of them runs now. */
  "ANDROID_SYSTEM_IMAGE_IN_USE",
  /** P3: an instrumentation test run already runs for this lane. */
  "ANDROID_TESTS_RUNNING",
] as const;
export type AndroidAgentErrorCode = (typeof ANDROID_AGENT_ERROR_CODES)[number];
/** Every code the backend refuses with. */
export type AndroidErrorCode = AndroidEmulatorErrorCode | AndroidAgentErrorCode;

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

/** Parity: launch arguments and intent extras ride on `launchApp` too (`androidEmulatorControl.ts`). */
export type AndroidLaunchArgs = AndroidInstallArgs & AndroidLaunchExtrasArgs & {
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

export type AndroidOpenUrlArgs = AndroidLaneArgs & AndroidInputRecordArgs & { url: string };

/* ---------- input ---------- */

/** How long a long press holds when the caller names no duration, and its bounds (as Apple's). */
export const ANDROID_LONG_PRESS_DEFAULT_MS = 1_000;
export const ANDROID_LONG_PRESS_MIN_MS = 100;
export const ANDROID_LONG_PRESS_MAX_MS = 5_000;

export type AndroidLongPressArgs = AndroidLaneArgs & AndroidInputRecordArgs & { x: number; y: number; durationMs?: number | null };

/**
 * A press that holds before it moves: drag and drop, reorder. A swipe moves
 * at once (a fling, a scroll).
 */
export type AndroidDragArgs = AndroidSwipeArgs;

export const ANDROID_SCROLL_DIRECTIONS = ["up", "down", "left", "right"] as const;
export type AndroidScrollDirection = (typeof ANDROID_SCROLL_DIRECTIONS)[number];

export type AndroidScrollArgs = AndroidLaneArgs & AndroidInputRecordArgs & {
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

export type AndroidTapElementArgs = AndroidElementQueryArgs & AndroidInputRecordArgs & {
  /** Hold the press this long: a long press on the element. */
  holdMs?: number | null;
};

export type AndroidFillElementArgs = AndroidElementQueryArgs & AndroidInputRecordArgs & {
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

/**
 * P2 crash pin: an app crash on the lane's emulator, from the device's crash
 * buffer (`logcat -b crash`, `androidCrashWatch.ts`). Only the lane's app
 * counts: the packages ADE installed for the lane, or, when it installed
 * none, any app that is not part of Android.
 */
export type AndroidAppCrash = {
  /** Unique per crash: `<time>:<pid>`. */
  id: string;
  /** The crashed app; null when the crash lines did not name it. */
  packageName: string | null;
  /** The crashed process. */
  pid: number | null;
  /** The crash's first line, as logcat printed it (epoch seconds, `1730000000.123`). */
  time: string;
  /** `java`: an uncaught exception. `native`: a signal in native code (a tombstone). */
  kind: "java" | "native";
  /** One line: the exception and its message, or the signal. */
  summary: string;
  /** The crash lines as text, at most `ANDROID_CRASH_STACK_MAX_CHARS`. */
  stack: string;
};

/** The longest crash text the pin carries; the rest stays in `ade android log`. */
export const ANDROID_CRASH_STACK_MAX_CHARS = 12_000;

/* ---------- recordings ---------- */

/**
 * One file of a recording. While it records, a rotation changes the picture's
 * size and starts a new part; at the stop the parts are joined into one
 * video (`androidDemoRecording.ts`), so a stopped recording lists one file.
 */
export type AndroidRecordingSegment = {
  path: string;
  width: number;
  height: number;
  durationMs: number;
  bytes: number;
  frames: number;
};

export type AndroidRecordingStopReason =
  | "requested"
  | "cap"
  | "device-off"
  | "stream-failed"
  | "released"
  | "chat-ended"
  /** The agent turn that started an automatic recording ended. */
  | "turn-end"
  /** Nothing happened on the recording for two minutes. */
  | "idle"
  /** The raw file reached its size limit, or the disk is almost full. */
  | "disk";

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
  /** The proof row it was filed as (one per recording). Empty when not filed. */
  proofArtifactIds: string[];
  /** Why it holds no video, when it does not. */
  lastError: string | null;
  /** `auto`: an agent's input started it, and its turn's end stops it. Absent on older sidecars (manual). */
  mode?: "auto" | "manual";
  /** Started with `--plain`: filed as recorded, with no demo treatment. */
  plain?: boolean;
  /** Tap rings and typed-text badges were on when it started (the machine preferences). */
  overlays?: boolean;
  /** Real time the video covers; `durationMs` is the video's own length. */
  wallDurationMs?: number | null;
  /** Still time left out of the video. */
  idleCutMs?: number | null;
  /** The wall-clock cap it stops at. */
  maxDurationMs?: number | null;
  /** How the demo was made, once it stopped. */
  demo?: DemoArtifactMetadata | null;
};

/** No recording runs longer than this (Apple's cap); `maxSeconds` may ask for less. */
export const ANDROID_RECORDING_MAX_SECONDS = 300;

export type AndroidRecordStartArgs = AndroidLaneArgs & {
  chatSessionId?: string | null;
  label?: string | null;
  maxSeconds?: number | null;
  /** File it as recorded, with no demo treatment (`record-start --plain`). */
  plain?: boolean | null;
  /** Zoom in on each tap in the demo (`record-start --zoom`). */
  zoom?: boolean | null;
};

export type AndroidRecordStopArgs = AndroidLaneArgs & {
  chatSessionId?: string | null;
  /** Delete the video instead of keeping and filing it. */
  discard?: boolean;
  /** Keep it (the default); wins over `discard`. */
  keep?: boolean;
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
  /** Set by the RPC server: a waiter whose caller went away leaves the line. Not on the wire. */
  connectionSignal?: AbortSignal | null;
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
  /** `android.permission.CAMERA`, or a short name from `ANDROID_PERMISSIONS` (`camera`). */
  permission: string;
};

/**
 * The runtime permissions the Tools drawer and `ade android permission` name.
 * `pm grant` needs the full name (`value`); `short` is the word an agent types.
 */
export const ANDROID_PERMISSIONS = [
  { value: "android.permission.CAMERA", label: "Camera", short: "camera" },
  { value: "android.permission.ACCESS_FINE_LOCATION", label: "Location", short: "location" },
  { value: "android.permission.RECORD_AUDIO", label: "Microphone", short: "microphone" },
  { value: "android.permission.POST_NOTIFICATIONS", label: "Notifications", short: "notifications" },
  { value: "android.permission.READ_CONTACTS", label: "Contacts", short: "contacts" },
  { value: "android.permission.READ_MEDIA_IMAGES", label: "Photos", short: "photos" },
  { value: "android.permission.READ_CALENDAR", label: "Calendar", short: "calendar" },
] as const;
export type AndroidPermissionName = (typeof ANDROID_PERMISSIONS)[number]["value"];

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
