import { useCallback, useEffect, useRef, useState } from "react";
import type { AppleDeviceListResult, IosSimulatorEventPayload } from "../../../shared/types/iosSimulator";
import { supportsIosSimulatorPlatform } from "../../lib/platform";
import { isWebClientMode } from "../../lib/webClientMode";
import { selectActiveProjectRoot, useAppStore } from "../../state/appStore";

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
 * No pin: the rows this feeds are the bound machine's lanes, and an unpinned
 * call goes to the bound runtime. Lanes on other machines are not covered.
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
export function laneAppleClaimSignature(owners: ReadonlyArray<{ laneId: string; udid: string }>): string {
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
}): LaneAppleDevices {
  const projectRoot = useAppStore(selectActiveProjectRoot);
  const bindingKind = useAppStore((state) => state.projectBinding?.kind ?? null);
  const bindingKey = useAppStore((state) => state.projectBinding?.key ?? null);
  const enabled = laneAppleDevicesSupported(bindingKind);
  const scope = enabled ? `${bindingKey ?? ""}\u0000${projectRoot ?? ""}` : null;

  const [devices, setDevices] = useState<LaneAppleDevices>(EMPTY);
  const devicesRef = useRef<LaneAppleDevices>(EMPTY);
  const scopeRef = useRef<string | null>(scope);
  const readRef = useRef<(withInstalled: boolean) => Promise<void>>(async () => {});

  const apply = useCallback((next: LaneAppleDevices) => {
    if (sameDevices(devicesRef.current, next)) return;
    devicesRef.current = next;
    setDevices(next);
  }, []);

  // A new project or machine starts empty rather than showing the last one's marks.
  useEffect(() => {
    scopeRef.current = scope;
    devicesRef.current = EMPTY;
    setDevices(EMPTY);
    if (!scope) return undefined;
    const read = async (withInstalled: boolean): Promise<void> => {
      const api = window.ade?.iosSimulator;
      if (!api?.deviceList) return;
      const listed = await api.deviceList({ installed: withInstalled }).catch(() => null);
      // A failed read keeps what is on screen; a blip should not blink the marks.
      if (!listed || scopeRef.current !== scope) return;
      const owners = listed.owners ?? [];
      // A new or moved claim needs its device's name, which only the installed
      // list has. A failed follow-up leaves the claims unchanged here, so the
      // next refresh tries again.
      if (!withInstalled && owners.length > 0
        && laneAppleClaimSignature(owners) !== mapSignature(devicesRef.current)) {
        return read(true);
      }
      apply(buildLaneAppleDevices(listed, devicesRef.current, withInstalled));
    };
    readRef.current = read;
    return () => {
      readRef.current = async () => {};
    };
  }, [apply, scope]);

  // The lane list's own refresh is the cadence for claims made where no event reaches us.
  useEffect(() => {
    if (!scope) return;
    void readRef.current(false);
  }, [scope, args.refreshKey]);

  useEffect(() => {
    if (!scope) return undefined;
    const api = window.ade?.iosSimulator;
    if (!api?.onEvent) return undefined;
    let timer: number | null = null;
    const unsubscribe = api.onEvent((event: IosSimulatorEventPayload) => {
      if (event.type !== "apple.device.state" && event.type !== "session-released") return;
      if (event.type === "apple.device.state") {
        const current = devicesRef.current.get(event.laneId);
        const running = event.phase === "booted" || event.phase === "streaming"
          ? true
          : event.phase === "stopped"
            ? false
            : null;
        if (current && current.udid === event.udid && running != null && current.running !== running) {
          const next = new Map(devicesRef.current);
          next.set(event.laneId, { ...current, running });
          apply(next);
        }
      }
      // A start can attach a device first, and a release moves one; re-read the claims.
      if (timer != null) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        timer = null;
        void readRef.current(false);
      }, EVENT_REFRESH_DELAY_MS);
    });
    return () => {
      if (timer != null) window.clearTimeout(timer);
      unsubscribe?.();
    };
  }, [apply, scope]);

  return devices;
}
