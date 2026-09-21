import { useCallback, useEffect, useRef, useState } from "react";
import type { AppleLaneDevice, OpenProjectBinding } from "../../../shared/types";

/**
 * The one device this lane owns, or null.
 *
 * The Work tab needs this ABOVE the Apple tool: the device's presence is what
 * decides whether the Apple column exists as a pane at all, and a pane cannot
 * be conjured by the component inside it. So the answer is read here, at the
 * layout's level, and handed down.
 *
 * `deviceList({ laneId })` is the cheapest question in the 2A surface — it
 * reads the lanes DB row, not `simctl` — which is why this polls it rather
 * than `status()`. A poll rather than an event because device creation happens
 * on the CLI, on another chat's turn and on a remote Mac, none of which reach
 * this renderer's event feed; `refresh()` exists so a local create can skip the
 * wait instead of leaving the user looking at a blank half-second.
 */

const POLL_MS = 5_000;

export function useAppleLaneDevice(args: {
  laneId: string | null;
  runtimePin: OpenProjectBinding | null;
  enabled: boolean;
}): { device: AppleLaneDevice | null; refresh: () => void } {
  const { laneId, runtimePin, enabled } = args;
  const [device, setDevice] = useState<AppleLaneDevice | null>(null);
  const [nonce, setNonce] = useState(0);
  const pinRef = useRef(runtimePin);
  pinRef.current = runtimePin;

  const refresh = useCallback(() => setNonce((value) => value + 1), []);

  useEffect(() => {
    if (!enabled || !laneId) {
      setDevice(null);
      return undefined;
    }
    let cancelled = false;
    const read = async () => {
      const api = window.ade?.iosSimulator;
      if (!api?.deviceList) {
        if (!cancelled) setDevice(null);
        return;
      }
      const listed = await api.deviceList({ laneId }, pinRef.current).catch(() => null);
      if (cancelled) return;
      setDevice(listed?.lane ?? null);
    };
    void read();
    const timer = window.setInterval(() => void read(), POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
    // `runtimePin` is read through a ref on purpose: the object identity churns
    // on every parent render and would restart the interval each time.
  }, [enabled, laneId, nonce]);

  return { device, refresh };
}
