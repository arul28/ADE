import type { AppleStreamState } from "./useAppleDeviceStream";
import type {
  AppleDeviceOrientation,
  AppleInstalledSimulator,
  IosScreenElement,
} from "../../../shared/types/iosSimulator";
import { commandFor } from "./appleInspectGeometry";

/**
 * The Apple pane's one state value.
 *
 * Round 1 had ten states describing what the SERVICE was doing — `creating`,
 * `building`, `watching`, `stalled` — and a header full of chips to narrate
 * them. The pane the user asked for has one job per state: show the picker,
 * show the loading card, show the device, or say the one sentence that
 * explains why none of those is possible. Eight values, each of which maps to
 * exactly one viewport in §3's table, and nothing here describes a chip.
 */

export type AppleDeviceState =
  /** The bound runtime is not a Mac. */
  | "unsupported"
  /** The runtime is a Mac, but this install shipped without the helper. */
  | "helper-missing"
  /** No device for this lane: the picker. */
  | "no-device"
  /** A `deviceStart` is in flight: the loading card. */
  | "starting"
  /** Frames are arriving. */
  | "live"
  /** Frames stopped, but the device is still up. */
  | "video-lost"
  /** The simulator is shut down. */
  | "stopped"
  /** A SwiftUI preview has taken over the viewport. */
  | "preview";

export type ResolveAppleDeviceStateInput = {
  /** `getStatus().supported` for the BOUND runtime, not the viewer's OS. */
  supported: boolean;
  /** `getStatus().tools` reports the helper as available. */
  helperAvailable: boolean;
  /** The lane owns a device record. */
  hasDevice: boolean;
  /** The lane's simulator is booted. */
  booted: boolean;
  /** A start/create is in flight. */
  starting: boolean;
  /** A rendered preview is on screen. */
  previewing: boolean;
  /**
   * The viewer has an address to read frames from.
   *
   * The machine cannot wait for FRAMES before it calls a device live: the
   * stage is the decoder, so a state that keeps the stage unmounted until a
   * frame arrives is a state no frame can ever leave. Readiness is the stream
   * having connected; a connection that then draws nothing is caught five
   * seconds later by `useAppleDeviceStream`'s first-frame watchdog and lands
   * here as `video-lost`.
   */
  streamReady: boolean;
  streamState: AppleStreamState;
};

/**
 * The order is the whole rule.
 *
 * Host facts first, because a Linux runtime is not a device problem with a
 * device fix. Then the preview, which is a deliberate takeover of the viewport
 * and outranks whatever the stream is doing underneath it. Then presence,
 * then the in-flight start, then power, and only then the stream — a lane that
 * owns no simulator must never be told "Video stopped", which is the exact
 * wrong answer round 1 shipped.
 */
export function resolveAppleDeviceState(input: ResolveAppleDeviceStateInput): AppleDeviceState {
  if (!input.supported) return "unsupported";
  if (!input.helperAvailable) return "helper-missing";
  if (input.previewing) return "preview";
  if (input.starting) return "starting";
  if (!input.hasDevice) return "no-device";
  if (!input.booted) return "stopped";
  if (input.streamState === "stalled" || input.streamState === "error") return "video-lost";
  // Round 2 called a device `live` whenever it was booted, whatever the stream
  // was doing, so a pane whose stream had not connected painted an empty black
  // stage that took input the user could not see the result of — the "input
  // does nothing" report, with the giveaway being the pane's own "Input
  // disconnected, reconnecting…" pill showing in a state it calls live.
  // Nothing to read from is `starting`; connected is `live`, and the watchdogs
  // above are what demote a connection that never draws.
  if (!input.streamReady) return "starting";
  return "live";
}

/** Input reaches the device only while the picture is real. */
export function appleInputAllowed(state: AppleDeviceState): boolean {
  return state === "live";
}

/** The rail is mounted in these states, and nowhere else. */
export function appleRailVisible(state: AppleDeviceState): boolean {
  return state === "live" || state === "video-lost";
}

/* ── Picker ordering ──────────────────────────────────────────────────────── */

/** Booted first, then alphabetical. No row is ever pre-selected. */
export function sortAppleSimulators(
  simulators: readonly AppleInstalledSimulator[],
): AppleInstalledSimulator[] {
  return [...simulators].sort((a, b) => {
    const booted = Number(isAppleSimulatorBooted(b)) - Number(isAppleSimulatorBooted(a));
    return booted !== 0 ? booted : a.name.localeCompare(b.name);
  });
}

export function isAppleSimulatorBooted(simulator: Pick<AppleInstalledSimulator, "state">): boolean {
  return simulator.state === "Booted";
}

/** `iOS 26.2 · Running` — the row's one description line. */
export function appleSimulatorDescription(simulator: AppleInstalledSimulator): string {
  return `${simulator.runtime} · ${isAppleSimulatorBooted(simulator) ? "Running" : "Stopped"}`;
}

/* ── The tools grid card ──────────────────────────────────────────────────── */

/**
 * §9's subtitle: `No device` | `{name} · Starting` | `{name} · Running` |
 * `{name} · Off`. One function so the picker card, the tab tooltip and the
 * palette cannot drift apart.
 */
export function appleToolCardSubtitle(device: {
  name: string | null | undefined;
  state: "starting" | "running" | "off";
} | null): string {
  if (!device) return "No device";
  const name = device.name?.trim() || "Simulator";
  const suffix = device.state === "starting"
    ? "Starting"
    : device.state === "running"
      ? "Running"
      : "Off";
  return `${name} · ${suffix}`;
}

/* ── Rotation ─────────────────────────────────────────────────────────────── */

/**
 * Rotate's 90° cycle: portrait → landscape-left → upside-down →
 * landscape-right → portrait. From an unknown orientation the first click goes
 * to landscape-left, the step after the default portrait.
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
 * own ref when the snapshot carries one: the refs are HASHED (`id:<hash>`),
 * and a raw identifier handed to `--ref` matches nothing.
 */
export function appleCommandForElement(element: IosScreenElement): string {
  const ref = element.metadata?.ref;
  if (typeof ref === "string" && ref.trim()) {
    return `ade --socket apple tap-element --ref ${shellQuote(ref.trim())}`;
  }
  return commandFor(element);
}

/* ── Recordings (round 3 §A3) ─────────────────────────────────────────────── */

/**
 * The proof link a finished recording carries.
 *
 * APPENDED for round 3 and shared on purpose: a recording becomes a proof
 * artifact by itself when it stops (there is no "Pin to proof" button any
 * more), and the drawer's row needs to know WHICH artifact so "Open in proof"
 * can go somewhere. Unit F fills this field on the record; Unit D only reads
 * it, which is why the reader below tolerates a record that predates it rather
 * than assuming the field is there.
 */
export type AppleRecordingProofLink = {
  /** The proof artifact this recording became, once it has one. */
  proofArtifactId?: string | null;
};

/**
 * The artifact id for a recording, or null when it has none yet.
 *
 * Reads the round-3 field and nothing else. A recording that only carries the
 * round-2 `proof: true` flag is deliberately NOT treated as openable: the flag
 * says "an artifact exists somewhere", not "here it is", and a button that
 * navigates to an id we do not have is worse than one that is visibly off.
 */
export function appleRecordingProofArtifactId(
  recording: AppleRecordingProofLink | null | undefined,
): string | null {
  const id = recording?.proofArtifactId;
  return typeof id === "string" && id.trim().length > 0 ? id.trim() : null;
}
