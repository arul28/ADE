import type { AppleDeviceListResult, IosSimulatorEventPayload } from "../../../shared/types/iosSimulator";
import { supportsIosSimulatorPlatform } from "../../lib/platform";
import { isWebClientMode } from "../../lib/webClientMode";
import { useRef } from "react";
import type { OpenProjectBinding } from "../../../shared/types/core";
import { useTabCopyPin } from "../../state/repositoryScope";
import { applePowerFromPhase } from "./appleDeviceState";
import { useLaneDeviceMarks } from "../device/useLaneDeviceMarks";

/**
 * Which lanes on the tab's machine hold an Apple device, for the Work sidebar.
 *
 * The lane rows only need a small mark, so this reads as little as it can:
 *
 * - `deviceList({ installed: false })` is a read of the lanes DB and nothing
 *   else. It runs whenever the lane list refreshes and after any Apple device
 *   event, so a claim or a release shows up on the lane list's own cadence.
 * - `deviceList({ installed: true })` adds one `simctl list` for the device
 *   names and whether each is booted. It runs only when the set of claims
 *   changes, never on a timer.
 * - Boot and shutdown events move the running tint directly, without a read.
 *
 * The pin names the machine of the lanes on screen. The Work list shows the
 * tab copy's lanes today, so a caller that passes no pin gets the tab's copy,
 * named explicitly. Lanes on other machines are not covered. With no copy (no
 * computer online) it reads nothing.
 */

export type LaneAppleDevice = {
  udid: string;
  /** The simulator's name, or null until the installed list has been read. */
  name: string | null;
  /** True when booted, false when off, null when not known yet. */
  running: boolean | null;
};

export type LaneAppleDevices = ReadonlyMap<string, LaneAppleDevice>;

const EMPTY: LaneAppleDevices = new Map();
const EVENT_REFRESH_DELAY_MS = 300;

/** The tooltip and accessible name for a lane's device mark. */
export function laneAppleDeviceLabel(device: LaneAppleDevice): string {
  const name = device.name?.trim() || "An Apple device";
  return `${name} on this lane${device.running === false ? " (off)" : ""}`;
}

/** One string per claim set, so a changed claim is one comparison. */
function laneAppleClaimSignature(owners: ReadonlyArray<{ laneId: string; udid: string }>): string {
  return owners
    .map((owner) => `${owner.laneId}=${owner.udid}`)
    .sort()
    .join("|");
}

function mapSignature(devices: LaneAppleDevices): string {
  return laneAppleClaimSignature([...devices].map(([laneId, device]) => ({ laneId, udid: device.udid })));
}

function sameDevices(a: LaneAppleDevices, b: LaneAppleDevices): boolean {
  if (a.size !== b.size) return false;
  for (const [laneId, device] of a) {
    const other = b.get(laneId);
    if (!other) return false;
    if (other.udid !== device.udid || other.name !== device.name || other.running !== device.running) return false;
  }
  return true;
}

/**
 * Lane id to device, from one `deviceList` answer.
 *
 * Without the installed list, a name and running state are carried over from
 * the previous map when the lane still holds the same device.
 */
export function buildLaneAppleDevices(
  listed: Pick<AppleDeviceListResult, "owners" | "installed">,
  previous: LaneAppleDevices,
  withInstalled: boolean,
): Map<string, LaneAppleDevice> {
  const installedByUdid = new Map((withInstalled ? listed.installed ?? [] : []).map((entry) => [entry.udid, entry]));
  const next = new Map<string, LaneAppleDevice>();
  for (const owner of listed.owners ?? []) {
    const laneId = owner.laneId?.trim();
    const udid = owner.udid?.trim();
    if (!laneId || !udid) continue;
    const before = previous.get(laneId);
    const kept = before?.udid === udid ? before : null;
    const installed = installedByUdid.get(udid);
    next.set(laneId, {
      udid,
      name: installed?.name ?? kept?.name ?? null,
      running: installed ? installed.state === "Booted" : kept?.running ?? null,
    });
  }
  return next;
}

/**
 * Whether to ask the bound machine about Apple devices at all.
 *
 * A remote binding may be a Mac whatever this computer is, so only a local
 * binding on a non-Mac is ruled out. The web client is left out: its
 * `deviceList` always runs `simctl`, and it gets no Apple events.
 */
export function laneAppleDevicesSupported(bindingKind: "local" | "remote" | null | undefined): boolean {
  if (isWebClientMode()) return false;
  return bindingKind === "remote" || supportsIosSimulatorPlatform();
}

export function useLaneAppleDevices(args: {
  /** Changes whenever the lane list refreshes; each change re-reads the claims. */
  refreshKey: unknown;
  /** The machine of those lanes. Omitted: the tab's copy (the lanes the Work list shows). */
  pin?: OpenProjectBinding | null;
}): LaneAppleDevices {
  const tabCopyPin = useTabCopyPin();
  const pin = args.pin === undefined ? tabCopyPin : args.pin;
  const pinRef = useRef(pin);
  pinRef.current = pin;
  const enabled = pin != null && laneAppleDevicesSupported(pin.kind);
  const scope = enabled ? pin.key : null;
  const api = typeof window !== "undefined" ? window.ade?.iosSimulator : undefined;

  const read = async (current: LaneAppleDevices, withInstalled: boolean): Promise<LaneAppleDevices | null> => {
    const readPin = pinRef.current;
    if (!api?.deviceList || !readPin) return null;
    const listed = await api.deviceList({ installed: withInstalled }, readPin).catch(() => null);
    // A failed read keeps what is on screen; a blip should not blink the marks.
    if (!listed) return null;
    const owners = listed.owners ?? [];
    // A new or moved claim needs its device's name, which only the installed
    // list has. A failed follow-up leaves the claims unchanged here, so the
    // next refresh tries again.
    if (!withInstalled && owners.length > 0 && laneAppleClaimSignature(owners) !== mapSignature(current)) {
      return read(current, true);
    }
    return buildLaneAppleDevices(listed, current, withInstalled);
  };

  // The lane list's own refresh is the cadence for claims made where no event reaches us.
  return useLaneDeviceMarks<LaneAppleDevice, IosSimulatorEventPayload>({
    scope,
    refreshKey: args.refreshKey,
    read: (current) => read(current, false),
    subscribe: api?.onEvent ? (listener) => api.onEvent(listener, pinRef.current) : null,
    onEvent: (event, current) => {
      if (event.type === "session-released") return null;
      if (event.type !== "apple.device.state") return false;
      // A start can attach a device first, and a release moves one; re-read the claims.
      const device = current.get(event.laneId);
      const power = applePowerFromPhase(event.phase);
      const running = power === null ? null : power === "on";
      if (!device || device.udid !== event.udid || running == null || device.running === running) return null;
      return new Map(current).set(event.laneId, { ...device, running });
    },
    same: sameDevices,
    eventDelayMs: EVENT_REFRESH_DELAY_MS,
  }, EMPTY);
}
