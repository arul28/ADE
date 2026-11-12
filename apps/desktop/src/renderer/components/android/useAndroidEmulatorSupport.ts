import { useEffect, useRef, useState } from "react";
import type { OpenProjectBinding } from "../../../shared/types";
import { useDeviceMachinePin } from "../apple/useDeviceMachinePin";

/**
 * Can the lane's runtime host run the Android emulator at all?
 *
 * One `androidEmulator.getStatus` per machine, cached for the life of the
 * renderer, never a poller: `platformSupported` is a property of the host's OS
 * and CPU. The SDK half of the answer is NOT cached here and is not part of
 * the gate, because a missing SDK keeps the tool (the panel shows the setup
 * card) and the panel re-reads it on use.
 *
 * Shaped like `useMacDesktopSupport`, keyed per machine: the host's pin, else
 * the tab's copy (`useDeviceMachinePin`).
 */

export type AndroidEmulatorSupport = {
  supported: boolean;
  reason: string | null;
};

const cache = new Map<string, AndroidEmulatorSupport>();

/** A few spaced re-reads after a failed one, then the answer stays unknown. */
const SUPPORT_RETRY_DELAYS_MS = [1_500, 5_000, 15_000] as const;

/** The `WorkToolContext` fields this answer fills. */
export function androidToolContext(support: AndroidEmulatorSupport | null): {
  supportsAndroidEmulator: boolean | null;
  androidEmulatorUnsupportedReason: string | null;
} {
  return {
    supportsAndroidEmulator: support ? support.supported : null,
    androidEmulatorUnsupportedReason: support?.reason ?? null,
  };
}

export function useAndroidEmulatorSupport(args: {
  runtimePin: OpenProjectBinding | null;
  /** The surface that needs the answer is on screen. Nothing is read otherwise. */
  enabled: boolean;
}): AndroidEmulatorSupport | null {
  // The lane's machine, the tab's copy included. No machine: no read.
  const pin = useDeviceMachinePin(args.runtimePin);
  const key = pin?.key ?? "";
  const [support, setSupport] = useState<AndroidEmulatorSupport | null>(() => (key ? cache.get(key) ?? null : null));
  const pinRef = useRef(pin);
  pinRef.current = pin;

  useEffect(() => {
    const cached = cache.get(key);
    if (cached !== undefined) {
      setSupport(cached);
      return;
    }
    setSupport(null);
    if (!args.enabled || !key) return;
    // Optional, not asserted: a shell whose `window.ade` predates the namespace
    // loses the answer (the tool stays visible), not the whole Work pane.
    const api = window.ade?.androidEmulator;
    if (!api?.getStatus) return;
    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    const read = (attempt: number): void => {
      const machinePin = pinRef.current;
      if (!machinePin) return;
      void api
        .getStatus({}, machinePin)
        .then((status) => {
          const answer: AndroidEmulatorSupport = {
            supported: status.platformSupported,
            reason: status.platformSupported ? null : (status.unsupportedReason ?? null),
          };
          cache.set(key, answer);
          if (!cancelled) setSupport(answer);
        })
        .catch(() => {
          // An unreachable host is not a "no": the tool stays, and the panel
          // says what went wrong when it is opened.
          if (cancelled) return;
          setSupport(null);
          const delay = SUPPORT_RETRY_DELAYS_MS[attempt];
          if (delay != null) retryTimer = setTimeout(() => read(attempt + 1), delay);
        });
    };
    read(0);
    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
    };
  }, [args.enabled, key]);

  return support;
}
