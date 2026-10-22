import { useSyncExternalStore } from "react";

/**
 * One renderer-side read of a machine-local bridge value, kept current by a
 * push event: one `get` when the first subscriber mounts, then events. Never a
 * poll.
 *
 * The two browser settings stores had the same `current`/`listeners`/`started`
 * trio and the same `useSyncExternalStore` wiring copied line for line. Each
 * store now supplies only its bridge, its shape guard and (when a desktop can
 * be older than the setting) a normalizer.
 */
export type BridgeSnapshotStatus = "loading" | "ready" | "failed" | "unavailable";

type BridgeSnapshotBridge<T> = {
  get: () => Promise<T>;
  onChange: (callback: (value: T) => void) => () => void;
};

export function createBridgeSnapshotStore<T>(options: {
  bridge: () => BridgeSnapshotBridge<T> | null;
  isValid: (value: unknown) => value is T;
  normalize?: (value: T) => T;
}) {
  let current: T | null = null;
  // "loading" and "failed" are different: a false error on the first paint is
  // as bad as no error at all.
  let status: BridgeSnapshotStatus = "loading";
  const listeners = new Set<() => void>();
  let started = false;

  const notify = (): void => {
    for (const listener of [...listeners]) listener();
  };

  const publish = (next: unknown): void => {
    if (!options.isValid(next)) return;
    current = options.normalize ? options.normalize(next) : next;
    status = "ready";
    notify();
  };

  const fail = (): void => {
    status = "failed";
    notify();
  };

  const start = (): void => {
    if (started) return;
    started = true;
    const bridge = options.bridge();
    if (!bridge) {
      // No bridge is the hosted web client or an old desktop: the surface is
      // hidden, not broken.
      status = "unavailable";
      notify();
      return;
    }
    try {
      bridge.onChange((value) => publish(value));
    } catch {
      // No event: the one read below still seeds the UI.
    }
    void bridge.get().then(publish, fail);
  };

  const subscribe = (listener: () => void): (() => void) => {
    listeners.add(listener);
    start();
    return () => {
      listeners.delete(listener);
    };
  };

  const getSnapshot = (): T | null => current;
  const getStatus = (): BridgeSnapshotStatus => status;

  return {
    publish,
    /** Try the first read again after it failed. */
    reload: (): void => {
      const bridge = options.bridge();
      if (!bridge) return;
      status = "loading";
      notify();
      void bridge.get().then(publish, fail);
    },
    /** `null` means nothing has arrived yet; check `useStatus` to tell why. */
    useSnapshot: (): T | null => useSyncExternalStore(subscribe, getSnapshot, getSnapshot),
    useStatus: (): BridgeSnapshotStatus => useSyncExternalStore(subscribe, getStatus, getStatus),
  };
}
