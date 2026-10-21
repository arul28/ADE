import { useCallback, useEffect, useRef, useState, type MutableRefObject } from "react";
import type {
  AppleRuntimeDeleteResult,
  AppleRuntimeInstallState,
  AppleRuntimeInventory,
  AppleRuntimeSimulatorDisposition,
  OpenProjectBinding,
} from "../../../shared/types";

/** An install that is still running on the owning machine. */
export function appleRuntimeInstallActive(install: AppleRuntimeInstallState | null | undefined): boolean {
  return Boolean(install && (install.phase === "checking" || install.phase === "preparing"
    || install.phase === "downloading" || install.phase === "installing"));
}

export type AppleRuntimes = {
  inventory: AppleRuntimeInventory | null;
  loading: boolean;
  error: unknown;
  /** A remove or prune is running. */
  removing: boolean;
  reload: () => void;
  install: () => Promise<void>;
  cancelInstall: () => void;
  remove: (id: string, simulators: AppleRuntimeSimulatorDisposition) => Promise<AppleRuntimeDeleteResult | null>;
  prune: (simulators: AppleRuntimeSimulatorDisposition) => Promise<AppleRuntimeDeleteResult | null>;
  runXcodeSetup: () => Promise<void>;
};

/**
 * The machine's simulator runtimes, for the picker's Runtimes section, the
 * Create control's "Not installed" option and the Xcode note.
 *
 * Every call carries the lane's pin, so it reads and changes the runtimes of
 * the machine that owns the lane's simulators. The list is read when the pane
 * opens, on `refreshNonce`, and when an install settles; progress in between
 * arrives as `apple.runtime.install` events, never by polling.
 */
export function useAppleRuntimes({
  runtimePinRef,
  pinKey,
  enabled,
  refreshNonce,
  onInstallSettled,
  onError,
}: {
  runtimePinRef: MutableRefObject<OpenProjectBinding | null>;
  /** `pin?.key`: the effect re-reads when the target machine changes, not when the pin object is rebuilt. */
  pinKey: string | null;
  enabled: boolean;
  refreshNonce: number;
  onInstallSettled?: (install: AppleRuntimeInstallState) => void;
  onError?: (error: unknown) => void;
}): AppleRuntimes {
  const [inventory, setInventory] = useState<AppleRuntimeInventory | null>(null);
  const [loading, setLoading] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const readTicket = useRef(0);
  const onSettledRef = useRef(onInstallSettled);
  onSettledRef.current = onInstallSettled;
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  const reload = useCallback(() => {
    const ticket = ++readTicket.current;
    setLoading(true);
    void window.ade.iosSimulator.runtimeList(runtimePinRef.current)
      .then((next) => {
        if (ticket !== readTicket.current) return;
        setInventory(next);
        setError(null);
      })
      .catch((cause: unknown) => {
        if (ticket === readTicket.current) setError(cause);
      })
      .finally(() => {
        if (ticket === readTicket.current) setLoading(false);
      });
  }, [runtimePinRef]);

  useEffect(() => {
    if (!enabled) return;
    reload();
  }, [enabled, pinKey, refreshNonce, reload]);

  useEffect(() => {
    if (!enabled) return;
    return window.ade.iosSimulator.onEvent((event) => {
      if (event.type !== "apple.runtime.install") return;
      setInventory((current) => (current ? { ...current, install: event.install } : current));
      if (!appleRuntimeInstallActive(event.install)) {
        onSettledRef.current?.(event.install);
        reload();
      }
    });
  }, [enabled, pinKey, reload]);

  const install = useCallback(async () => {
    try {
      const started = await window.ade.iosSimulator.runtimeInstall({}, runtimePinRef.current);
      setInventory((current) => (current ? { ...current, install: started } : current));
    } catch (cause) {
      onErrorRef.current?.(cause);
    }
  }, [runtimePinRef]);

  const cancelInstall = useCallback(() => {
    void window.ade.iosSimulator.runtimeInstallCancel(runtimePinRef.current)
      .then((state) => setInventory((current) => (current ? { ...current, install: state } : current)))
      .catch((cause: unknown) => onErrorRef.current?.(cause));
  }, [runtimePinRef]);

  /**
   * CoreSimulator unmounts a deleted runtime a moment after `simctl runtime
   * delete` returns, so a list read straight away can still show it. Re-read
   * until the removed runtimes are gone (a few seconds at most).
   */
  const reloadUntilGone = useCallback(async (removedIds: string[]) => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const next = await window.ade.iosSimulator.runtimeList(runtimePinRef.current).catch(() => null);
      if (next) setInventory(next);
      if (!next || !next.runtimes.some((entry) => entry.id && removedIds.includes(entry.id))) return;
      await new Promise((resolve) => setTimeout(resolve, 1_500));
    }
  }, [runtimePinRef]);

  const runRemoval = useCallback(async (call: () => Promise<AppleRuntimeDeleteResult>) => {
    setRemoving(true);
    let result: AppleRuntimeDeleteResult | null = null;
    try {
      result = await call();
      return result;
    } catch (cause) {
      onErrorRef.current?.(cause);
      return null;
    } finally {
      await reloadUntilGone(result?.deleted.map((entry) => entry.id) ?? []);
      setRemoving(false);
    }
  }, [reloadUntilGone]);

  const remove = useCallback((id: string, simulators: AppleRuntimeSimulatorDisposition) => runRemoval(() =>
    window.ade.iosSimulator.runtimeDelete({ id, simulators, confirmedByUser: true }, runtimePinRef.current)), [runRemoval, runtimePinRef]);

  const prune = useCallback((simulators: AppleRuntimeSimulatorDisposition) => runRemoval(() =>
    window.ade.iosSimulator.runtimePrune({ simulators, confirmedByUser: true }, runtimePinRef.current)), [runRemoval, runtimePinRef]);

  const runXcodeSetup = useCallback(async () => {
    try {
      const xcode = await window.ade.iosSimulator.xcodeRunFirstLaunch({ confirmedByUser: true }, runtimePinRef.current);
      setInventory((current) => (current ? { ...current, xcode } : current));
    } catch (cause) {
      onErrorRef.current?.(cause);
    }
  }, [runtimePinRef]);

  return { inventory, loading, error, removing, reload, install, cancelInstall, remove, prune, runXcodeSetup };
}
