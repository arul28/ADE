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

/* ── AVD names ───────────────────────────────────────────────────────────── */

/** Profile words that read as one token in capitals: `pixel_9_xl` is "Pixel 9 XL". */
const ANDROID_UPPER_WORDS = new Set(["xl", "tv", "api", "fe", "se"]);

/**
 * A person's name for an AVD folder name. ADE names the AVDs it makes
 * `ade_<short lane id>_<profile>`, so `ade_ab12cd34_pixel_9_pro` reads "Pixel 9
 * Pro". A `_2` that tells two such AVDs apart stays: it cannot be told from a
 * model number (`pixel_9`). Any other AVD name reads with its underscores as spaces.
 */
export function androidAvdDisplayName(avdName: string): string {
  const bare = avdName.trim().replace(/^ade_[A-Za-z0-9]+_/, "");
  const words = bare.split(/[_\s]+/).filter(Boolean);
  if (words.length === 0) return avdName.trim();
  return words
    .map((word) => (ANDROID_UPPER_WORDS.has(word.toLowerCase())
      ? word.toUpperCase()
      : `${word.charAt(0).toUpperCase()}${word.slice(1)}`))
    .join(" ");
}
