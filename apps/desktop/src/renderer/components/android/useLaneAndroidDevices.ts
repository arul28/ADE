import { useCallback, useEffect, useRef, useState } from "react";
import type { AndroidDeviceInventory, AndroidEmulatorEvent } from "../../../shared/types/androidEmulator";
import { logRendererDebugEvent } from "../../lib/debugLog";
import { selectActiveProjectRoot, useAppStore } from "../../state/appStore";
import { androidAvdDisplayName } from "../../../shared/computerUseActionOutput";

/**
 * Which lanes on the tab's machine hold an Android emulator, for the Work
 * session list: the twin of `useLaneAppleDevices`.
 *
 * One `listDevices` read for the whole list (each AVD says which lane holds
 * it and whether it runs). That read asks adb about each running emulator, so
 * it runs only when it can change the answer:
 *
 * - on mount and when the project or machine changes;
 * - when the SET of lane ids changes (a lane added or removed), not on every
 *   lane-list refresh;
 * - after an Android event (`android.device.state`, `android.inventory.changed`),
 *   once per burst. A state event moves the running tint at once, before the read.
 *
 * No pin: the rows this feeds are the bound machine's lanes, and an unpinned
 * call goes to the bound runtime. Lanes on other machines are not covered,
 * the same as Apple's marks.
 */

export type LaneAndroidDevice = {
  avdName: string;
  name: string;
  /** True while the emulator is booted. */
  running: boolean;
};

export type LaneAndroidDevices = ReadonlyMap<string, LaneAndroidDevice>;

const EMPTY: LaneAndroidDevices = new Map();
const EVENT_REFRESH_DELAY_MS = 400;

/** The tooltip and accessible name for a lane's emulator mark. */
export function laneAndroidDeviceLabel(device: LaneAndroidDevice): string {
  return `${device.name} on this lane${device.running ? "" : " (off)"}`;
}

/** Lane id to emulator, from one inventory answer. */
export function buildLaneAndroidDevices(inventory: Pick<AndroidDeviceInventory, "avds">): Map<string, LaneAndroidDevice> {
  const next = new Map<string, LaneAndroidDevice>();
  for (const avd of inventory.avds ?? []) {
    const laneId = avd.heldByLaneId?.trim();
    if (!laneId) continue;
    next.set(laneId, { avdName: avd.name, name: avd.displayName?.trim() || androidAvdDisplayName(avd.name) || avd.name, running: avd.running?.booted === true });
  }
  return next;
}

function sameDevices(a: LaneAndroidDevices, b: LaneAndroidDevices): boolean {
  if (a.size !== b.size) return false;
  for (const [laneId, device] of a) {
    const other = b.get(laneId);
    if (!other || other.avdName !== device.avdName || other.name !== device.name || other.running !== device.running) return false;
  }
  return true;
}

export function useLaneAndroidDevices(args: {
  /** The lane ids on screen; only a change in the SET reads again. */
  laneIds: readonly string[];
}): LaneAndroidDevices {
  const projectRoot = useAppStore(selectActiveProjectRoot);
  const bindingKey = useAppStore((state) => state.projectBinding?.key ?? null);
  const available = typeof window !== "undefined" && Boolean(window.ade?.androidEmulator?.listDevices);
  const scope = available ? `${bindingKey ?? ""}\u0000${projectRoot ?? ""}` : null;
  const laneSignature = [...args.laneIds].sort().join("|");

  const [devices, setDevices] = useState<LaneAndroidDevices>(EMPTY);
  const devicesRef = useRef<LaneAndroidDevices>(EMPTY);
  const scopeRef = useRef<string | null>(scope);
  scopeRef.current = scope;

  const apply = useCallback((next: LaneAndroidDevices) => {
    if (sameDevices(devicesRef.current, next)) return;
    devicesRef.current = next;
    setDevices(next);
  }, []);

  const read = useCallback(async () => {
    const api = window.ade?.androidEmulator;
    const readScope = scopeRef.current;
    if (!api?.listDevices || !readScope) return;
    let inventory: AndroidDeviceInventory;
    try {
      inventory = await api.listDevices({});
    } catch (cause: unknown) {
      // A failed read keeps the marks on screen; a blip should not blink them.
      logRendererDebugEvent("android.lane_marks_read_failed", { error: cause instanceof Error ? cause.message : String(cause) });
      return;
    }
    if (scopeRef.current !== readScope) return;
    apply(buildLaneAndroidDevices(inventory));
  }, [apply]);

  // A new project or machine starts empty rather than showing the last one's marks.
  useEffect(() => {
    devicesRef.current = EMPTY;
    setDevices(EMPTY);
  }, [scope]);

  useEffect(() => {
    if (!scope) return;
    void read();
  }, [laneSignature, read, scope]);

  useEffect(() => {
    if (!scope) return undefined;
    const api = window.ade?.androidEmulator;
    if (!api?.onEvent) return undefined;
    let timer: number | null = null;
    const unsubscribe = api.onEvent((event: AndroidEmulatorEvent) => {
      if (event.type !== "android.device.state" && event.type !== "android.inventory.changed") return;
      if (event.type === "android.device.state") {
        const current = devicesRef.current.get(event.laneId);
        const running = event.state === "booted";
        if (current && current.running !== running) {
          const next = new Map(devicesRef.current);
          next.set(event.laneId, { ...current, running });
          apply(next);
        }
      }
      if (timer != null) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        timer = null;
        void read();
      }, EVENT_REFRESH_DELAY_MS);
    });
    return () => {
      if (timer != null) window.clearTimeout(timer);
      unsubscribe?.();
    };
  }, [apply, read, scope]);

  return devices;
}
