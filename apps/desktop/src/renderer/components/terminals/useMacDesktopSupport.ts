import { useEffect, useRef, useState } from "react";
import type { OpenProjectBinding } from "../../../shared/types";

/**
 * Can the lane's runtime host host a Mac Desktop display?
 *
 * One read per machine, cached for the life of the renderer, and never a
 * poller. The answer is a property of a machine's OS and its driver install —
 * it changes when ADE is updated or a helper is installed, which is a restart
 * either way — so re-asking on an interval would spend an RPC round-trip per
 * tick to learn the same thing.
 *
 * `getStatus` is the one Mac Desktop call that answers on every platform, which
 * is exactly why the capability gate is a read rather than a rejection: a
 * Windows host has to be able to say "no display here" without throwing.
 *
 * Deliberately NOT folded into `useNativeToolSessions`: that hook opens live
 * event subscriptions for three tools, and this needs no subscription at all.
 */

const cache = new Map<string, boolean>();

/** Test-only reset for the module-level capability cache. */
export function resetMacDesktopSupportCache(): void {
  cache.clear();
}

export function useMacDesktopSupport(args: {
  runtimePin: OpenProjectBinding | null;
  /** The Work route is on screen. Nothing is read otherwise. */
  enabled: boolean;
}): boolean | null {
  const key = args.runtimePin?.key ?? "bound";
  const [supported, setSupported] = useState<boolean | null>(() => cache.get(key) ?? null);
  const pinRef = useRef(args.runtimePin);
  pinRef.current = args.runtimePin;

  useEffect(() => {
    const cached = cache.get(key);
    if (cached !== undefined) {
      setSupported(cached);
      return;
    }
    if (!args.enabled) return;
    // Optional call, not an assertion. A surface whose `window.ade` predates
    // this namespace — an older packaged shell, a partially stubbed host —
    // must lose the capability answer, not the whole Work pane.
    const api = window.ade.macDesktop;
    if (!api) return;
    let cancelled = false;
    void api
      .getStatus({}, pinRef.current)
      .then((status) => {
        cache.set(key, status.supported);
        if (!cancelled) setSupported(status.supported);
      })
      .catch(() => {
        // An unreachable host is not a "no". Leaving it unknown keeps the tool
        // visible, and the panel says what actually went wrong when it is opened.
        if (!cancelled) setSupported(null);
      });
    return () => {
      cancelled = true;
    };
  }, [args.enabled, key]);

  return supported;
}
