/**
 * The Android emulator contract at `ade apple`'s level for the device state
 * the parity audit found missing: the accessibility switches, the status bar
 * override (SystemUI demo mode), Clear location, the reverse rotations,
 * Play Store screenshots for every posture of a foldable, and the window
 * layout of a large screen (split screen and free windows).
 * Re-exported from `androidEmulator.ts`; import from there.
 */

import type { DeviceOrientation } from "./deviceOrientation";
import type { AndroidLaneArgs } from "./androidEmulator";

/* ---------- actions ---------- */

/** The agent actions this file adds. Spread into `ANDROID_AGENT_ACTIONS`. */
export const ANDROID_DEVICE_ACTIONS = [
  "setStatusBar",
  "clearStatusBar",
  "clearLocation",
  "storeScreenshots",
  "windowLayout",
] as const;
export type AndroidDeviceAction = (typeof ANDROID_DEVICE_ACTIONS)[number];

/* ---------- accessibility ---------- */

/**
 * The accessibility switches, with `ade apple accessibility`'s names where
 * the job is the same. Each one is a `settings put secure` key that Android
 * 12 (API 31) and later read at once, on Google APIs and Play images alike:
 *
 * - `increase-contrast`: `high_text_contrast_enabled` (High contrast text).
 * - `bold-text`: `font_weight_adjustment` 300 (Bold text, API 31+).
 * - `invert-colors`: `accessibility_display_inversion_enabled`.
 * - `grayscale` and `color-correction`: the daltonizer
 *   (`accessibility_display_daltonizer_enabled`, mode 0 is grayscale, 12 is
 *   deuteranomaly). They share it, so one turns the other off.
 * - `talkback`: TalkBack in `enabled_accessibility_services`. Only an image
 *   that has the TalkBack app has it (Play images do; most Google APIs images
 *   do not), and the read is null without it.
 *
 * Reduce Motion is the Device group's "Animations off" switch.
 */
export const ANDROID_ACCESSIBILITY_OPTIONS = [
  "increase-contrast",
  "bold-text",
  "invert-colors",
  "grayscale",
  "color-correction",
  "talkback",
] as const;
export type AndroidAccessibilityOption = (typeof ANDROID_ACCESSIBILITY_OPTIONS)[number];

export const ANDROID_ACCESSIBILITY_LABELS: Record<AndroidAccessibilityOption, string> = {
  "increase-contrast": "High contrast text",
  "bold-text": "Bold text",
  "invert-colors": "Color inversion",
  grayscale: "Grayscale",
  "color-correction": "Color correction",
  talkback: "TalkBack",
};

export function isAndroidAccessibilityOption(value: unknown): value is AndroidAccessibilityOption {
  return typeof value === "string" && (ANDROID_ACCESSIBILITY_OPTIONS as readonly string[]).includes(value);
}

/* ---------- status bar ---------- */

/**
 * `setStatusBar`: SystemUI demo mode, with `ade apple status-bar`'s fields.
 * Every field is optional; an omitted one takes the screenshot value (9:41,
 * full bars, a full battery that is not charging, no notification icons).
 */
export type AndroidStatusBarArgs = AndroidLaneArgs & {
  /** `H:MM` or `HH:MM`, 24-hour. Default `9:41`. */
  time?: string | null;
  /** `wifi` (Wi-Fi only, the default), or a mobile type: `5g`, `lte`, `4g`, `3g`, `e`, `g`. */
  dataNetwork?: string | null;
  /** 0 to 4. Default 4. */
  wifiBars?: number | null;
  /** 0 to 4. Default 4. */
  cellularBars?: number | null;
  /** 0 to 100. Default 100. */
  batteryLevel?: number | null;
  batteryState?: "charging" | "charged" | "discharging" | null;
};

export const ANDROID_STATUS_BAR_NETWORKS = ["wifi", "5g", "lte", "4g", "3g", "e", "g"] as const;

export type AndroidStatusBarResult = {
  laneId: string;
  /** Demo mode is on (`sysui_tuner_demo_on` reads 1 after the change). */
  overridden: boolean;
  time: string | null;
};

/* ---------- location ---------- */

/**
 * Where a cold-booted emulator puts its GPS (the Googleplex). The emulator
 * has no "no location": Clear location moves the GPS back here.
 */
export const ANDROID_DEFAULT_LOCATION = { latitude: 37.4219983, longitude: -122.084 } as const;

export type AndroidClearLocationResult = { laneId: string; latitude: number; longitude: number; cleared: true };

/* ---------- rotation ---------- */

/**
 * `rotate`'s names, `ade apple rotate`'s. `landscape` is kept for older
 * callers: it is `landscape-right` (the device turned a quarter to the left,
 * Android's rotation 1 on a phone).
 */
export const ANDROID_ROTATE_ORIENTATIONS = [
  "portrait",
  "landscape",
  "portrait-upside-down",
  "landscape-left",
  "landscape-right",
] as const;

/**
 * The device's turn as the shared device views name it, from Android's
 * display rotation (0 to 3, a quarter turn to the left each) and the
 * display's natural shape. A phone is portrait at rotation 0; a tablet that
 * is landscape at rotation 0 shows `landscape-right` there.
 */
export function androidOrientationFor(rotation: number, naturalLandscape: boolean): DeviceOrientation {
  const phone: DeviceOrientation[] = ["portrait", "landscape-right", "portrait-upside-down", "landscape-left"];
  const tablet: DeviceOrientation[] = ["landscape-right", "portrait", "landscape-left", "portrait-upside-down"];
  const index = ((Math.round(rotation) % 4) + 4) % 4;
  return (naturalLandscape ? tablet : phone)[index]!;
}

/** The rotation (0 to 3) that shows `orientation`. `landscape` is `landscape-right`. */
export function androidRotationFor(orientation: string, naturalLandscape: boolean): number | null {
  const name = orientation === "landscape" ? "landscape-right" : orientation;
  for (let rotation = 0; rotation < 4; rotation += 1) {
    if (androidOrientationFor(rotation, naturalLandscape) === name) return rotation;
  }
  return null;
}

/** Pushed after a rotate (from any caller), so a viewer draws the device turned the right way. */
export type AndroidOrientationEvent = {
  type: "android.device.orientation";
  laneId: string;
  orientation: DeviceOrientation;
};

/* ---------- Play Store screenshots ---------- */

/**
 * Google Play's slot for a shot. `phone`: the phone screenshots.
 * `large-screen`: the 7-inch and 10-inch tablet screenshots (Play uses them
 * for tablets, Chromebooks and the inner screen of a foldable).
 */
export type AndroidStoreShotSlot = "phone" | "large-screen";

export type AndroidStoreScreenshotsArgs = AndroidLaneArgs & {
  chatSessionId?: string | null;
  /** False: write the PNGs but file no proof (a `--machine` caller files them itself). */
  proof?: boolean | null;
};

export type AndroidStoreShot = {
  /** `cover` (shut) and `inner` (open) on a foldable; `screen` on any other device. */
  display: "cover" | "inner" | "screen";
  slot: AndroidStoreShotSlot;
  /** The PNG's size: 9:16 or 16:9, short side 1080 or more, long side 3840 or less. */
  width: number;
  height: number;
  /** The device screen's own size, before it was placed on the canvas. */
  screenWidth: number;
  screenHeight: number;
  filePath: string;
  proofArtifactId: string | null;
};

export type AndroidStoreScreenshotsResult = {
  laneId: string;
  foldable: boolean;
  shots: AndroidStoreShot[];
};

/* ---------- windows ---------- */

/**
 * `windowLayout` (`ade android window`): the windows of a large screen (a
 * tablet, or a foldable open). `ade apple window`'s verb, with Android's own
 * window modes:
 *
 * - `status`: list the app windows, front first.
 * - `split`: two apps side by side: `packageName` beside `withPackage` (or
 *   beside the app in front). `left`, `right`, `top`, `bottom`: put the app
 *   (or the app in front) on that side of a split screen. Android splits a
 *   portrait screen top and bottom, a landscape one left and right; the side
 *   that does not fit the screen's shape is refused.
 * - `swap`: change the two sides over.
 * - `freeform`: open the app in a free window (Android turns on
 *   `enable_freeform_support` first when it is off). `size` and `move`
 *   change a free window.
 * - `fill`: the app full screen again. `close`: remove its window (task).
 */
export const ANDROID_WINDOW_LAYOUT_ACTIONS = [
  "status",
  "split",
  "left",
  "right",
  "top",
  "bottom",
  "swap",
  "freeform",
  "size",
  "move",
  "fill",
  "close",
] as const;
export type AndroidWindowLayoutAction = (typeof ANDROID_WINDOW_LAYOUT_ACTIONS)[number];

export type AndroidWindowLayoutArgs = AndroidLaneArgs & {
  action?: AndroidWindowLayoutAction | null;
  /** The app to place. Omitted = the app in front. */
  packageName?: string | null;
  /** `split`: the other app. Omitted = the app in front (or the one behind it). */
  withPackage?: string | null;
  /** Pixels, with `size`. */
  width?: number | null;
  height?: number | null;
  /** Pixels, with `move`: where the window's top-left corner goes. */
  x?: number | null;
  y?: number | null;
};

export type AndroidWindowFrame = { x: number; y: number; width: number; height: number };

export type AndroidWindowMode = "fullscreen" | "split" | "freeform" | "pip" | "other";

export type AndroidWindow = {
  taskId: number;
  packageName: string;
  activity: string | null;
  mode: AndroidWindowMode;
  frame: AndroidWindowFrame;
  visible: boolean;
};

export type AndroidWindowLayoutResult = {
  laneId: string;
  action: AndroidWindowLayoutAction;
  /** The screen in pixels, as it is turned now. */
  screen: { width: number; height: number } | null;
  /** The app the action placed; null for `status` and `swap`. */
  packageName: string | null;
  /** App windows after the action, front first (the home screen left out). */
  windows: AndroidWindow[];
  /** The window ended where the action asked. Always true for `status`. */
  applied: boolean;
  /** Why `applied` is false, in a sentence. */
  reason?: string | null;
};

/* ---------- service ---------- */

export type AndroidEmulatorDeviceServiceApi = {
  setStatusBar(args: AndroidStatusBarArgs): Promise<AndroidStatusBarResult>;
  clearStatusBar(args: AndroidLaneArgs): Promise<AndroidStatusBarResult>;
  /** Moves the GPS back to the emulator's default point (it has no "no location"). */
  clearLocation(args: AndroidLaneArgs): Promise<AndroidClearLocationResult>;
  /** The screen of each posture at Google Play's screenshot rules, filed as proof. */
  storeScreenshots(args: AndroidStoreScreenshotsArgs): Promise<AndroidStoreScreenshotsResult>;
  windowLayout(args: AndroidWindowLayoutArgs): Promise<AndroidWindowLayoutResult>;
};
