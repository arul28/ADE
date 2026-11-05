import { readLaneAndroidDevice, type AndroidLaneDeviceStore } from "../android/androidLaneDeviceStore";

/**
 * The turn-time hint that tells an agent its lane has an ADE Android emulator,
 * on the pattern of `laneAppleDeviceDirective.ts` (read its header for why a
 * skill alone is not enough: the Cursor prompt has a 3 KB budget).
 *
 * Without it an agent asked to "test the app on Android" reaches for
 * `emulator -avd` (a second emulator on the user's machine, outside ADE's
 * lane rules) or `adb kill-server` (which cuts every live view and every
 * other lane's emulator off adb).
 *
 * A lane with both devices gets ONE `<ade-lane-tools>` block that names both
 * (`combineLaneDeviceDirectives`). Its dedupe key is the Apple key alone when
 * the lane has no emulator, so an Apple-only lane's hint and its delivery are
 * exactly what they were.
 *
 * Unlike the Apple lookup, this one runs on every host: the emulator runs on
 * macOS, Windows and Linux.
 */

export type LaneAndroidDeviceRef = { avdName: string };

/** Which AVD a lane holds. Must be cheap: it runs on every send. */
export type LaneAndroidDeviceLookup = (laneId: string) => LaneAndroidDeviceRef | null;

/** The default lookup: one row read from `lane_android_devices`. Null without a database. */
export function createLaneAndroidDeviceLookup(args: {
  store: Pick<AndroidLaneDeviceStore, "get"> | null | undefined;
}): LaneAndroidDeviceLookup | null {
  if (!args.store) return null;
  const store = args.store;
  return (laneId) => {
    const device = readLaneAndroidDevice(store, laneId);
    return device ? { avdName: device.avdName } : null;
  };
}

/** An AVD name is user-chosen for an attached AVD; keep it to one short line with no markup. */
function cleanField(value: string, max: number): string {
  return value.replace(/[<>`"\r\n\t]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

/**
 * The hint's lines, without the `<ade-lane-tools>` tags. `besideApple`: the
 * Apple lines above already say what `$ADE_CLI_PATH` is and how to check a
 * step and share a device, so those are said in fewer words (the two together
 * stay under Cursor's 3 KB).
 */
export function buildLaneAndroidDeviceLines(device: LaneAndroidDeviceRef, options: { besideApple?: boolean } = {}): string[] | null {
  const avdName = cleanField(device.avdName, 80);
  if (!avdName) return null;
  const cli = "\"$ADE_CLI_PATH\" android";
  const besideApple = options.besideApple === true;
  return [
    `This lane's Android emulator is ${avdName}, shown live in the ADE tools pane. Drive it with \`${cli} <command>\` (skill \`ade-android\`; \`${cli} --help\`)${besideApple ? "." : "; `$ADE_CLI_PATH` is the ADE that launched you."}`,
    `Start it with \`${cli} start --text\`. Build, install and open the app: \`${cli} launch --gradle --text\` (or \`--apk <path>\`). Read the screen with \`${cli} snapshot --text\`, then \`tap-element\`, \`fill-element\`, \`wait-for-element\`, \`assert-visible\` (\`--label\`, \`--text\`, \`--identifier\`). Logs: \`${cli} log --package <pkg> --text\`.`,
    `Video proof: \`${cli} record-start --text\`, then \`${cli} record-stop --text\` (files to this chat's proof drawer). Screenshot: \`${cli} screenshot --text\`.`,
    "Never run `emulator -avd`, `adb kill-server` or `adb emu kill`, and never make an AVD with `avdmanager`: this lane has its emulator.",
    besideApple
      ? `Check each step and take turns on it as for the Apple device, with \`${cli} snapshot\` and \`${cli} lease\`.`
      : `Check each step: an ok result only means the input was sent; confirm with \`snapshot\` or \`assert-visible\`. Sharing it with other agents? \`${cli} lease --wait 300 --holder <your name> --text\`, then \`${cli} lease release --token <t> --text\`.`,
  ];
}

export function buildLaneAndroidDeviceDirective(device: LaneAndroidDeviceRef): string | null {
  const lines = buildLaneAndroidDeviceLines(device);
  return lines ? ["<ade-lane-tools>", ...lines, "</ade-lane-tools>"].join("\n") : null;
}

/** Resolve the lane's Android hint and its key (the AVD name). Never throws. */
export function resolveLaneAndroidDeviceDirective(args: {
  laneId: string | null | undefined;
  lookup: LaneAndroidDeviceLookup | null | undefined;
  onLookupError?: (error: unknown) => void;
}): { directive: string; key: string; lines: string[]; linesBesideApple: string[] } | null {
  const laneId = args.laneId?.trim();
  if (!laneId || !args.lookup) return null;
  let device: LaneAndroidDeviceRef | null;
  try {
    device = args.lookup(laneId);
  } catch (error) {
    try {
      args.onLookupError?.(error);
    } catch {
      // Logging is best-effort.
    }
    return null;
  }
  if (!device) return null;
  const lines = buildLaneAndroidDeviceLines(device);
  if (!lines) return null;
  return {
    directive: ["<ade-lane-tools>", ...lines, "</ade-lane-tools>"].join("\n"),
    key: device.avdName.trim(),
    lines,
    linesBesideApple: buildLaneAndroidDeviceLines(device, { besideApple: true }) ?? lines,
  };
}

/** The lines inside one `<ade-lane-tools>` block. */
function innerLines(directive: string): string[] {
  return directive
    .split("\n")
    .filter((line) => line.trim() !== "<ade-lane-tools>" && line.trim() !== "</ade-lane-tools>");
}

/**
 * One hint for the lane's devices. The Apple one alone is returned as it is
 * (same text, same key), so its dedupe is unchanged; with an emulator too,
 * both go in one block, and the key changes when either device does.
 */
export function combineLaneDeviceDirectives(
  apple: { directive: string; key: string } | null,
  android: { directive: string; key: string; linesBesideApple: string[] } | null,
): { directive: string; key: string } | null {
  if (!android) return apple;
  if (!apple) return { directive: android.directive, key: `android:${android.key}` };
  return {
    directive: ["<ade-lane-tools>", ...innerLines(apple.directive), ...android.linesBesideApple, "</ade-lane-tools>"].join("\n"),
    key: `${apple.key}|android:${android.key}`,
  };
}
