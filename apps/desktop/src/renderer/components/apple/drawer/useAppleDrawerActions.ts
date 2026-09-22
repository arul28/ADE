import { useCallback, useEffect, useRef, useState, type MutableRefObject } from "react";
import type { IosSimulatorDeviceSettings, OpenProjectBinding } from "../../../../shared/types";

/**
 * One serialized `act()` for the whole drawer, and the one settings snapshot
 * every control reads from.
 *
 * Nothing in the drawer is optimistic: a control shows the value the DEVICE
 * last confirmed, and a write that the service refuses leaves the control
 * where it was. Actions run one at a time — a second click while one is in
 * flight is dropped, not queued — and every settled action re-reads the
 * device's settings, which is what replaces the snapshot.
 *
 * The generation counter makes hiding and re-showing safe. Hiding invalidates
 * the RESULT, not the command: the helper is still running it, so when the
 * drawer reopens it must not paint a reply to a question it no longer
 * remembers asking. A stale action's answer is discarded and the settings are
 * read again under the new generation.
 */

export type AppleDrawerScope = {
  laneId: string;
  deviceUdid: string;
  chatSessionId: null;
};

export type AppleDrawerActions = {
  settings: IosSimulatorDeviceSettings | null;
  pending: boolean;
  error: unknown;
  clearError: () => void;
  reportError: (error: unknown) => void;
  /**
   * Run one device command. Resolves true on success. A rejected command
   * surfaces through `error` and resolves false; it never throws, so a
   * section can `.then(accepted => …)` without its own try/catch.
   */
  act: (work: () => Promise<unknown>) => Promise<boolean>;
  /** Re-read the settings snapshot without running a command. */
  refresh: () => void;
  /** §5: `pending || !settings || !visible`. */
  disabled: boolean;
};

export function useAppleDrawerActions({
  scope,
  pinRef,
  visible,
}: {
  scope: AppleDrawerScope;
  pinRef: MutableRefObject<OpenProjectBinding | null>;
  visible: boolean;
}): AppleDrawerActions {
  const [settings, setSettings] = useState<IosSimulatorDeviceSettings | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [refreshNonce, setRefreshNonce] = useState(0);
  const busy = useRef(false);
  const generation = useRef(0);
  const { laneId, deviceUdid } = scope;

  const readSettings = useCallback(async (revision: number) => {
    try {
      const next = await window.ade.iosSimulator.getDeviceSettings(
        { laneId, deviceUdid, chatSessionId: null },
        pinRef.current,
      );
      if (generation.current !== revision) return;
      setSettings(next);
    } catch (cause: unknown) {
      if (generation.current !== revision) return;
      setSettings(null);
      setError(cause);
    }
  }, [deviceUdid, laneId, pinRef]);

  useEffect(() => {
    const revision = ++generation.current;
    if (!visible) {
      setSettings(null);
      return undefined;
    }
    void readSettings(revision);
    return () => {
      generation.current += 1;
    };
  }, [readSettings, refreshNonce, visible]);

  const act = useCallback(async (work: () => Promise<unknown>): Promise<boolean> => {
    if (busy.current || !visible) return false;
    busy.current = true;
    const revision = ++generation.current;
    setPending(true);
    setError(null);
    let accepted = false;
    try {
      await work();
      accepted = true;
    } catch (cause: unknown) {
      if (generation.current === revision) setError(cause);
    } finally {
      busy.current = false;
      setPending(false);
    }
    // Confirm from the device either way: a refused write still leaves the
    // snapshot as the device has it, and a stale generation reads fresh.
    await readSettings(generation.current === revision ? revision : ++generation.current);
    return accepted;
  }, [readSettings, visible]);

  const clearError = useCallback(() => setError(null), []);
  const reportError = useCallback((cause: unknown) => setError(cause), []);
  const refresh = useCallback(() => setRefreshNonce((nonce) => nonce + 1), []);

  return {
    settings,
    pending,
    error,
    clearError,
    reportError,
    act,
    refresh,
    disabled: pending || !settings || !visible,
  };
}
