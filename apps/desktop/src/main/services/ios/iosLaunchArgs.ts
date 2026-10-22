/**
 * The inputs a launch may be given, checked before anything boots, builds or
 * terminates. `launch` takes both; `relaunch` takes the arguments.
 */

/**
 * The Xcode configuration to build: `Debug` unless the caller named one. A
 * name, not a flag: it lands in xcodebuild's argv and in a products path.
 */
export function normalizeBuildConfiguration(value: unknown): string {
  if (value == null) return "Debug";
  if (typeof value !== "string") throw new Error("An Xcode build configuration must be a string.");
  const name = value.trim();
  if (!name) return "Debug";
  if (!/^[A-Za-z0-9][A-Za-z0-9 _.-]{0,63}$/.test(name)) {
    throw new Error(`'${String(value)}' is not an Xcode build configuration name.`);
  }
  return name;
}

/** Far past any real launch, well under macOS's argv limit for `simctl`. */
const MAX_LAUNCH_ARGUMENTS = 256;
const MAX_LAUNCH_ARGUMENT_BYTES = 64 * 1024;

export function normalizeLaunchArguments(value: unknown): string[] {
  if (value == null) return [];
  if (!Array.isArray(value)) {
    throw new Error("iOS Simulator launch arguments must be an array.");
  }
  if (value.length > MAX_LAUNCH_ARGUMENTS) {
    throw new Error(`An app can be given at most ${MAX_LAUNCH_ARGUMENTS} launch arguments.`);
  }
  let bytes = 0;
  for (const item of value) {
    if (typeof item !== "string") {
      throw new Error("iOS Simulator launch arguments must be an array of strings.");
    }
    bytes += Buffer.byteLength(item);
  }
  if (bytes > MAX_LAUNCH_ARGUMENT_BYTES) {
    throw new Error(`Launch arguments come to ${bytes} bytes; the limit is ${MAX_LAUNCH_ARGUMENT_BYTES}.`);
  }
  return value as string[];
}
