/**
 * How Android emulators look in the Android pane, on this computer.
 *
 * The counterpart of `appleDevice` in `appleDeviceSettings.ts`, kept the same
 * way: renderer user preferences, persisted under `android` in the
 * preferences blob and synced per device as `android.realisticBody`. The
 * recording and streaming choices are NOT here: they belong to the machine
 * that runs the emulator (`AndroidMachinePreferences`, read and written
 * through the runtime with the settings page's pin).
 */

export const ANDROID_DEVICE_SETTING_KEYS = {
  realisticBody: "android.realisticBody",
} as const;

export const DEFAULT_ANDROID_REALISTIC_BODY = true;

export type AndroidDevicePreferences = {
  /** Show the device body in 3D view. Off draws the bare screen. */
  realisticBody: boolean;
};

export const DEFAULT_ANDROID_DEVICE_PREFERENCES: AndroidDevicePreferences = {
  realisticBody: DEFAULT_ANDROID_REALISTIC_BODY,
};

export function normalizeAndroidDevicePreferences(value: unknown): AndroidDevicePreferences {
  const record = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  return {
    realisticBody: typeof record.realisticBody === "boolean" ? record.realisticBody : DEFAULT_ANDROID_REALISTIC_BODY,
  };
}
