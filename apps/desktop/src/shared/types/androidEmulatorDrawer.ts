/**
 * The Android emulator contract, the Tools drawer: the device settings and
 * the agent verbs a desktop window calls. Re-exported from
 * `androidEmulator.ts`; import from there.
 */

import type { OpenProjectBinding } from "./core";
import type { AndroidEmulatorServiceApi, AndroidLaneArgs } from "./androidEmulator";

type Pin = OpenProjectBinding | null | undefined;

/* ---------- the Tools drawer's device settings ---------- */

/** Android's text sizes, smallest first. The service sets each as a `font_scale`: 0.85, 1, 1.15, 1.3. */
export const ANDROID_TEXT_SIZES = [
  { value: "small", label: "Small" },
  { value: "default", label: "Default" },
  { value: "large", label: "Large" },
  { value: "largest", label: "Largest" },
] as const;
export type AndroidTextSize = (typeof ANDROID_TEXT_SIZES)[number]["value"];

/** Android's display sizes, smallest first. The service sets each as a density scale: 0.85, 1, 1.15, 1.3. */
export const ANDROID_DISPLAY_SIZES = [
  { value: "small", label: "Small" },
  { value: "default", label: "Default" },
  { value: "large", label: "Large" },
  { value: "larger", label: "Larger" },
] as const;
export type AndroidDisplaySize = (typeof ANDROID_DISPLAY_SIZES)[number]["value"];

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

/** The agent verbs a desktop window calls: the Tools drawer, Inspect and Record. */
export type AndroidToolsPreloadAction =
  | "listApps"
  | "installApp"
  | "launchApp"
  | "terminateApp"
  | "uninstallApp"
  | "openUrl"
  | "getScreenSnapshot"
  | "recordStart"
  | "recordStop"
  | "recordList"
  | "recordDelete"
  | "setLocation"
  | "setAppearance"
  | "setPermission"
  | "getDeviceSettings"
  | "setDeviceSetting"
  // P2: the Logs group.
  | "readLog";

/** What one service method answers, without the promise. */
export type AndroidServiceResult<K extends keyof AndroidEmulatorServiceApi> = Awaited<ReturnType<AndroidEmulatorServiceApi[K]>>;

/**
 * The Tools drawer's verbs on `window.ade.androidEmulator`: each service
 * method with the optional machine pin last, read from the service's own
 * types. Runtime-only routes (no IPC channel), as App Control's: the pane
 * exists only in a project, and the project's runtime owns the emulator.
 */
export type AndroidEmulatorToolsPreloadApi = {
  [K in AndroidToolsPreloadAction]: AndroidToolsPreloadMethod<K>;
};

/** One Tools drawer verb on the preload: the service's argument, then the optional machine pin. */
export type AndroidToolsPreloadMethod<K extends AndroidToolsPreloadAction> = (
  args: Parameters<AndroidEmulatorServiceApi[K]>[0],
  pin?: Pin,
) => Promise<AndroidServiceResult<K>>;
