import { useEffect, useRef, useState } from "react";
import { subscribeRemoteRuntimeIdentityChanges, subscribeRuntimeIdentityChanges } from "../../lib/runtimeIdentity";

/**
 * The frame both lane-mark hooks share (`useLaneAppleDevices`,
 * `useLaneAndroidDevices`): lane id to device, for the small marks on the
 * Work session list. Each platform gives its own read and event mapping.
 *
 * - A new scope (project or machine) starts empty, not with the last marks.
 * - The read runs when the scope or `refreshKey` changes, and once after
 *   each burst of relevant events (`eventDelayMs` after the last one).
 * - An event can move a mark at once, before the read (`onEvent`).
 * - A read that answers after the scope changed, or that gives null (a
 *   failed read), keeps what is on screen.
 * - A new map that is the same as the shown one (`same`) does not render.
 * - A restarted or reconnected brain reads again: its startup reconcile can
 *   release lanes before this window subscribes to its events.
 */
export type LaneDeviceMarksSource<Device, Event> = {
  /** Null turns the marks off (no API, or the host cannot have the device). */
  scope: string | null;
  refreshKey: unknown;
  /** The new marks, or null to keep the current ones. `current` is what is on screen. */
  read: (current: ReadonlyMap<string, Device>) => Promise<ReadonlyMap<string, Device> | null>;
  /** The platform's event subscription, or null when it has none. */
  subscribe: ((listener: (event: Event) => void) => () => void) | null;
  /**
   * What one event does: `false` ignores it; `null` reads again; a map
   * also moves the marks at once.
   */
  onEvent: (event: Event, current: ReadonlyMap<string, Device>) => ReadonlyMap<string, Device> | null | false;
  same: (a: ReadonlyMap<string, Device>, b: ReadonlyMap<string, Device>) => boolean;
  eventDelayMs: number;
};

export function useLaneDeviceMarks<Device, Event>(
  source: LaneDeviceMarksSource<Device, Event>,
  empty: ReadonlyMap<string, Device>,
): ReadonlyMap<string, Device> {
  const { scope, refreshKey, eventDelayMs } = source;
  const [devices, setDevices] = useState<ReadonlyMap<string, Device>>(empty);
  const devicesRef = useRef<ReadonlyMap<string, Device>>(empty);
  const scopeRef = useRef<string | null>(scope);
  scopeRef.current = scope;
  // The platform's callbacks, read through a ref so callers can pass them inline.
  const sourceRef = useRef(source);
  sourceRef.current = source;

  const applyRef = useRef((next: ReadonlyMap<string, Device>) => {
    if (sourceRef.current.same(devicesRef.current, next)) return;
    devicesRef.current = next;
    setDevices(next);
  });
  const readRef = useRef(async () => {
    const readScope = scopeRef.current;
    if (!readScope) return;
    const next = await sourceRef.current.read(devicesRef.current);
    if (!next || scopeRef.current !== readScope) return;
    applyRef.current(next);
  });

  useEffect(() => {
    devicesRef.current = empty;
    setDevices(empty);
  }, [empty, scope]);

  useEffect(() => {
    if (!scope) return;
    void readRef.current();
  }, [scope, refreshKey]);

  useEffect(() => {
    if (!scope) return undefined;
    const subscribe = sourceRef.current.subscribe;
    if (!subscribe) return undefined;
    let timer: number | null = null;
    const unsubscribe = subscribe((event) => {
      const patched = sourceRef.current.onEvent(event, devicesRef.current);
      if (patched === false) return;
      if (patched) applyRef.current(patched);
      if (timer != null) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        timer = null;
        void readRef.current();
      }, eventDelayMs);
    });
    return () => {
      if (timer != null) window.clearTimeout(timer);
      unsubscribe?.();
    };
  }, [eventDelayMs, scope]);

  useEffect(() => {
    if (!scope) return undefined;
    // The local status is a heartbeat whose first report is the brain the
    // scope read above already asked. A remote snapshot comes only on a
    // change, so each one reads again.
    let firstLocal = true;
    const unsubscribers = [
      subscribeRuntimeIdentityChanges(() => {
        if (firstLocal) {
          firstLocal = false;
          return;
        }
        void readRef.current();
      }),
      subscribeRemoteRuntimeIdentityChanges(() => void readRef.current()),
    ];
    return () => {
      for (const unsubscribe of unsubscribers) unsubscribe?.();
    };
  }, [scope]);

  return devices;
}
