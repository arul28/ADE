/**
 * What a launch may be given, checked once for `launch` and `relaunch` alike,
 * before anything boots, builds or terminates.
 */

/**
 * The Xcode configuration to build: `Debug` unless the caller named one. A
 * name, not a flag: it lands in xcodebuild's argv and in a products path.
 */
export function normalizeBuildConfiguration(value: unknown): string {
  if (value == null) return "Debug";
  const name = typeof value === "string" ? value.trim() : "";
  if (!name) return "Debug";
  if (!/^[A-Za-z0-9][A-Za-z0-9 _.-]{0,63}$/.test(name)) {
    throw new Error(`'${String(value)}' is not an Xcode build configuration name.`);
  }
  return name;
}

export function normalizeLaunchArguments(value: unknown): string[] {
  if (value == null) return [];
  if (!Array.isArray(value)) {
    throw new Error("iOS Simulator launch arguments must be an array.");
  }
  for (const item of value) {
    if (typeof item !== "string") {
      throw new Error("iOS Simulator launch arguments must be an array of strings.");
    }
  }
  return value as string[];
}
