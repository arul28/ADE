import { readLaneAndroidDevice, type AndroidLaneDeviceStore } from "../android/androidLaneDeviceStore";
import { resolveLaneAppleDeviceDirective, type LaneAppleDeviceLookup } from "./laneAppleDeviceDirective";

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
 * (`resolveLaneDeviceDirective`). Its dedupe key is the Apple key alone when
 * the lane has no emulator, so an Apple-only lane's hint and its delivery are
 * exactly what they were.
 *
 * The commands are written for the agent's shell: `"$ADE_CLI_PATH"` for a
 * POSIX shell, `& "$env:ADE_CLI_PATH"` for PowerShell (the shell the session
 * guidance names on Windows).
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

/** The shell an agent's commands are written for. */
export type LaneDirectiveShell = "posix" | "powershell";

/** `ade android` as the agent's shell runs it. */
function androidCli(shell: LaneDirectiveShell): { cli: string; variable: string } {
  return shell === "powershell"
    ? { cli: "& \"$env:ADE_CLI_PATH\" android", variable: "$env:ADE_CLI_PATH" }
    : { cli: "\"$ADE_CLI_PATH\" android", variable: "$ADE_CLI_PATH" };
}

/**
 * The hint's lines, without the `<ade-lane-tools>` tags. `besideApple`: the
 * Apple lines above already say what `$ADE_CLI_PATH` is and how to check a
 * step and share a device, so those are said in fewer words (the two together
 * stay under Cursor's 3 KB).
 */
function buildLaneAndroidDeviceLines(
  device: LaneAndroidDeviceRef,
  options: { besideApple?: boolean; shell?: LaneDirectiveShell } = {},
): string[] | null {
  const avdName = cleanField(device.avdName, 80);
  if (!avdName) return null;
  const { cli, variable } = androidCli(options.shell ?? "posix");
  const besideApple = options.besideApple === true;
  return [
    `This lane's Android emulator is ${avdName}, shown live in the ADE tools pane. Drive it with \`${cli} <command>\` (skill \`ade-android\`; \`${cli} --help\`)${besideApple ? "." : `; \`${variable}\` is the ADE that launched you.`}`,
    `Start it with \`${cli} start --text\`. Build, install and open the app: \`${cli} launch --gradle --text\` (or \`--apk <path>\`). Read the screen with \`${cli} snapshot --text\`, then \`tap-element\`, \`fill-element\`, \`wait-for-element\`, \`assert-visible\` (\`--label\`, \`--text\`, \`--identifier\`). Logs: \`${cli} log --package <pkg> --text\`.`,
    `Video proof: \`${cli} record-start --text\`, then \`${cli} record-stop --text\` (files to this chat's proof drawer). Screenshot: \`${cli} screenshot --text\`.`,
    "Never run `emulator -avd`, `adb kill-server` or `adb emu kill`, and never make an AVD with `avdmanager`: this lane has its emulator.",
    besideApple
      ? `Check each step and take turns on it as for the Apple device, with \`${cli} snapshot\` and \`${cli} lease\`.`
      : `Check each step: an ok result only means the input was sent; confirm with \`snapshot\` or \`assert-visible\`. Sharing it with other agents? \`${cli} lease --wait 300 --holder <your name> --text\`, then \`${cli} lease release --token <t> --text\`.`,
  ];
}

/** Calls a lookup; a throw means no device, logged when the caller asks. Never throws. */
function lookUp<T>(lookup: (laneId: string) => T | null, laneId: string, onError?: (error: unknown) => void): T | null {
  try {
    return lookup(laneId);
  } catch (error) {
    try {
      onError?.(error);
    } catch {
      // Logging is best-effort.
    }
    return null;
  }
}

/**
 * The lane's device hint, for its Apple device, its Android emulator, or
 * both in one block, with its dedupe key. The Apple one alone is its own text
 * and key, so its delivery is unchanged; with an emulator too, the key
 * changes when either device does. Never throws: a failed lookup means no
 * hint for that device.
 */
export function resolveLaneDeviceDirective(args: {
  laneId: string | null | undefined;
  appleLookup: LaneAppleDeviceLookup | null | undefined;
  androidLookup: LaneAndroidDeviceLookup | null | undefined;
  shell: LaneDirectiveShell;
  onAppleLookupError?: (error: unknown) => void;
  onAndroidLookupError?: (error: unknown) => void;
}): { directive: string; key: string; lines: string[] } | null {
  const apple = resolveLaneAppleDeviceDirective({ laneId: args.laneId, lookup: args.appleLookup, onLookupError: args.onAppleLookupError });
  const laneId = args.laneId?.trim();
  const device = laneId && args.androidLookup ? lookUp(args.androidLookup, laneId, args.onAndroidLookupError) : null;
  const android = device ? buildLaneAndroidDeviceLines(device, { besideApple: apple !== null, shell: args.shell }) : null;
  if (!device || !android) return apple;
  const lines = [...(apple?.lines ?? []), ...android];
  const androidKey = `android:${device.avdName.trim()}`;
  return {
    directive: ["<ade-lane-tools>", ...lines, "</ade-lane-tools>"].join("\n"),
    key: apple ? `${apple.key}|${androidKey}` : androidKey,
    lines,
  };
}
