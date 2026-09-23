import { readLaneAppleDevice, type LaneDeviceStore } from "../ios/laneDeviceRegistry";

/**
 * The turn-time hint that tells an agent its lane has an ADE Apple device.
 *
 * The `ade-apple` skill carries the real rules, but agents only see a skill
 * index (the Cursor SDK prompt has a hard 3 KB budget), so a request like
 * "record yourself opening Safari" was answered from default knowledge:
 * `xcrun simctl io … recordVideo` and `open -a Simulator`. That opened a second
 * Simulator window on the owner's Mac and filed proof outside ADE's recorder.
 *
 * This block rides the provider-bound prompt (never the transcript) on the
 * first turn after a device is bound and again only when the bound udid
 * changes — see `lastAppleDeviceDirectiveKey` in the chat service.
 */

export type LaneAppleDeviceRef = { udid: string; name: string };

/** Which device a lane holds. Must be cheap: it runs on every send. */
export type LaneAppleDeviceLookup = (laneId: string) => LaneAppleDeviceRef | null;

/**
 * The default lookup: one row read from `lane_apple_devices`.
 *
 * Null (no lookup at all) off macOS. The table is local-only and nothing
 * creates rows off a Mac, so this is belt and braces: a Windows or Linux host
 * never pays the query and never tells an agent about a device it cannot drive.
 */
export function createLaneAppleDeviceLookup(args: {
  platform: NodeJS.Platform;
  store: Pick<LaneDeviceStore, "get"> | null | undefined;
}): LaneAppleDeviceLookup | null {
  if (args.platform !== "darwin" || !args.store) return null;
  const store = args.store;
  return (laneId) => readLaneAppleDevice(store, laneId);
}

/** A device name is user-editable; keep it to one short line with no markup. */
function cleanDeviceField(value: string, max: number): string {
  return value.replace(/[<>`"\r\n\t]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

export function buildLaneAppleDeviceDirective(device: LaneAppleDeviceRef): string | null {
  const udid = cleanDeviceField(device.udid, 64);
  if (!udid) return null;
  const name = cleanDeviceField(device.name, 80) || "Apple simulator";
  return [
    "<ade-lane-tools>",
    `This lane's Apple device is ${name} (${udid}), shown live in the ADE tools pane. Drive it with \`"$ADE_CLI_PATH" apple <command>\` (skill \`ade-apple\`; \`"$ADE_CLI_PATH" apple --help\`); \`$ADE_CLI_PATH\` is the ADE that launched you.`,
    "Video proof: `\"$ADE_CLI_PATH\" apple record-start --text`, then `\"$ADE_CLI_PATH\" apple record-stop --text` (files to this chat's proof drawer automatically). Screenshot: `\"$ADE_CLI_PATH\" apple screenshot --out shot.png --text`.",
    "Never run `open -a Simulator`, AppleScript/System Events, or `xcrun simctl io … recordVideo`/`screenshot` for this device.",
    "If recording fails, say so. Never attach an older recording or a file you did not just record.",
    "To show the device to the user, run `\"$ADE_CLI_PATH\" apple show`.",
    "</ade-lane-tools>",
  ].join("\n");
}

/**
 * Resolve this turn's hint and its dedupe key (the bound udid).
 *
 * Never throws: a failed lookup is logged by the caller and means no hint, so
 * a broken lanes DB can never fail a send.
 */
export function resolveLaneAppleDeviceDirective(args: {
  laneId: string | null | undefined;
  lookup: LaneAppleDeviceLookup | null | undefined;
  onLookupError?: (error: unknown) => void;
}): { directive: string; key: string } | null {
  const laneId = args.laneId?.trim();
  if (!laneId || !args.lookup) return null;
  let device: LaneAppleDeviceRef | null;
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
  const directive = buildLaneAppleDeviceDirective(device);
  if (!directive) return null;
  return { directive, key: device.udid.trim() };
}
