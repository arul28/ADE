import type { AppleStreamState } from "./useAppleDeviceStream";
import type { AppleDeviceOrientation, IosScreenElement } from "../../../shared/types/iosSimulator";
import { commandFor } from "./appleInspectGeometry";

/**
 * The column's one state value, and the header chips it produces.
 *
 * Kept out of the component because it is the part with rules: the stream has
 * its own state, and a ready device with a dead stream is a different and real
 * thing from a device that is not there. Every ordering decision below is one
 * of those two facts winning over the other, and each was a wrong answer at
 * some point in the drawer this replaces — "No frames", with a Reconnect
 * button, on a lane that owned no simulator at all.
 */

export type AppleDeviceState =
  | "no-device"
  | "creating"
  | "booting"
  | "ready-no-app"
  | "building"
  | "app-running"
  | "watching"
  | "stalled"
  | "powered-off"
  | "error";

export type ResolveAppleDeviceStateInput = {
  /** This machine can host a simulator. */
  supported: boolean;
  /** The lane owns a device record. */
  hasLaneDevice: boolean;
  /** The lane's device is shut down. */
  poweredOff: boolean;
  /** A clone is being made right now. */
  creating: boolean;
  /** A boot is in flight. */
  booting: boolean;
  /** A build/install/launch is in flight. */
  building: boolean;
  /** Another chat owns the session. A watcher can never launch. */
  ownedByOtherChat: boolean;
  /** An app session names a bundle id on this device. */
  hasAppSession: boolean;
  streamState: AppleStreamState;
  /** A launch step failed, or a device call was refused. */
  failed: boolean;
};

export function resolveAppleDeviceState(input: ResolveAppleDeviceStateInput): AppleDeviceState {
  // A runtime that is not a Mac is not a device problem with a device fix; it
  // is the terminal error state with its own action (bind to a Mac).
  if (!input.supported) return "error";
  if (input.creating) return "creating";
  if (input.booting) return "booting";
  if (!input.hasLaneDevice) return "no-device";
  if (input.poweredOff) return "powered-off";
  if (input.failed) return "error";
  // Ownership outranks the stream: a watcher sees the same pixels and the same
  // stall, but the ribbon is the thing it must be told first.
  if (input.ownedByOtherChat) return "watching";
  // `building` before `stalled`, because the stepper is the more specific
  // answer to "why is nothing moving" while a build is running, and the spec
  // keeps the stream live underneath it.
  if (input.building) return "building";
  if (input.streamState === "stalled" || input.streamState === "error") return "stalled";
  return input.hasAppSession ? "app-running" : "ready-no-app";
}

export type AppleHeaderChip = {
  label: string;
  detail: string | null;
  tone: "active" | "starting" | "error";
};

/**
 * Section 3's chip column, verbatim.
 *
 * `building` is the only state with two chips — Live AND Building — because the
 * stream really is live underneath the stepper and saying only one of those two
 * things leaves the other invisible.
 */
export function appleHeaderChips(
  state: AppleDeviceState,
  streamChip: AppleHeaderChip | null,
): AppleHeaderChip[] {
  switch (state) {
    case "no-device":
    case "powered-off":
      return [];
    case "creating":
      return [{ label: "Creating", detail: null, tone: "starting" }];
    case "booting":
      return [{ label: "Booting", detail: null, tone: "starting" }];
    case "error":
      return [{ label: "Error", detail: streamChip?.detail ?? null, tone: "error" }];
    case "stalled":
      return [{ label: "Stalled", detail: streamChip?.detail ?? null, tone: "error" }];
    case "building":
      return [
        streamChip ?? { label: "Live", detail: null, tone: "active" },
        { label: "Building", detail: null, tone: "starting" },
      ];
    case "watching":
    case "app-running":
    case "ready-no-app":
    default:
      return streamChip ? [streamChip] : [];
  }
}

/** Input is refused in these states, whatever the toolbar looks like. */
export function appleInputAllowed(state: AppleDeviceState): boolean {
  return state === "ready-no-app" || state === "app-running" || state === "building";
}

/**
 * Home / Rotate / Shake's rotate cycle: 90° each click.
 *
 * Portrait → landscape-left → upside-down → landscape-right → portrait.
 * Starting from an unknown orientation, the first click goes to landscape-left
 * (the step after the default portrait).
 */
export const APPLE_DEVICE_ORIENTATION_CYCLE = [
  "portrait",
  "landscape-left",
  "portrait-upside-down",
  "landscape-right",
] as const satisfies readonly AppleDeviceOrientation[];

export function nextAppleDeviceOrientation(
  current: AppleDeviceOrientation,
): AppleDeviceOrientation {
  const index = APPLE_DEVICE_ORIENTATION_CYCLE.indexOf(current);
  const nextIndex = index < 0 ? 1 : (index + 1) % APPLE_DEVICE_ORIENTATION_CYCLE.length;
  return APPLE_DEVICE_ORIENTATION_CYCLE[nextIndex] ?? "landscape-left";
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_.:/=@+-]+$/u.test(value)) return value;
  return `'${value.replace(/'/gu, `'\\''`)}'`;
}

/**
 * The `ade apple tap-element` command for an element, preferring the service's
 * own ref when the snapshot carries one.
 *
 * `appleInspectGeometry.commandFor` builds its query from the raw identifier,
 * which is right for a human reading the panel and wrong for a paste: the
 * service's element refs are HASHED (`id:<shortHash>`), and a raw identifier
 * handed to `--ref` matches nothing. When the host does carry a `ref` — it does
 * on element-action results, and may start carrying it on snapshot rows — that
 * is the string the CLI will actually resolve, so it wins.
 */
export function appleCommandForElement(element: IosScreenElement): string {
  const ref = element.metadata?.ref;
  if (typeof ref === "string" && ref.trim()) {
    return `ade --socket apple tap-element --ref ${shellQuote(ref.trim())}`;
  }
  return commandFor(element);
}
