import { useCallback, useEffect, useRef, useState } from "react";
import type { OpenProjectBinding } from "../../../shared/types";
import type {
  AndroidMachinePreferences,
  AndroidMachinePreferencesResult,
} from "../../../shared/types/androidEmulator";
import { showToast } from "../app/toast/toastStore";
import { describeAndroidError, type AndroidErrorDescription } from "./androidDeviceState";

/**
 * The Android preferences of ONE machine: the machine that runs the emulator.
 *
 * Overlays, automatic recording, the storage warning and the remote bitrate
 * cap belong to that machine, so they are read and written through its
 * runtime (`getMachinePreferences` / `setMachinePreferences`) with the
 * caller's `pin`. A null pin is the tab's own machine. Effects key on
 * `pin?.key`, so a pin rebuilt with the same key does not read again.
 *
 * A write is optimistic: the page shows the new value at once. If the machine
 * refuses it, the fields it changed go back to what the machine holds and a
 * toast says why. `android.preferences.changed` (a write from another window,
 * the CLI or another machine's settings page) refreshes the values.
 */
export type AndroidMachinePreferencesState = {
  preferences: AndroidMachinePreferences | null;
  /** Bytes of this project's Android recordings on that machine; null when unknown. */
  recordingsBytes: number | null;
  /** The last read failed. Null after a good read. */
  error: AndroidErrorDescription | null;
  /** This window has no Android API at all. (An older ADE on the machine fails the read instead: `error`.) */
  unsupported: boolean;
  loading: boolean;
  refresh: () => void;
  update: (partial: Partial<AndroidMachinePreferences>) => void;
};

export function useAndroidMachinePreferences(
  pin: OpenProjectBinding | null,
  options: { listen?: boolean; machineName?: string | null } = {},
): AndroidMachinePreferencesState {
  const listen = options.listen !== false;
  const pinRef = useRef(pin);
  pinRef.current = pin;
  const pinKey = pin?.key ?? null;
  const machineNameRef = useRef(options.machineName ?? null);
  machineNameRef.current = options.machineName ?? null;
  const api = window.ade?.androidEmulator ?? null;
  const canRead = typeof api?.getMachinePreferences === "function";
  const [preferences, setPreferences] = useState<AndroidMachinePreferences | null>(null);
  const [recordingsBytes, setRecordingsBytes] = useState<number | null>(null);
  const [error, setError] = useState<AndroidErrorDescription | null>(null);
  const [loading, setLoading] = useState(canRead);
  /** The machine's last confirmed values: what a refused write goes back to. */
  const confirmedRef = useRef<AndroidMachinePreferences | null>(null);
  /** Bumped by every read and write; a late answer from an older one is dropped. */
  const seqRef = useRef(0);
  /**
   * The sequence of the read, write or event that set `confirmedRef`. An
   * answer from an older one (a write reply that arrives after a newer write
   * or a `preferences.changed` event) does not replace it.
   */
  const confirmedSeqRef = useRef(0);
  const confirm = useCallback((seq: number, preferences: AndroidMachinePreferences) => {
    if (seq < confirmedSeqRef.current) return;
    confirmedSeqRef.current = seq;
    confirmedRef.current = preferences;
  }, []);

  const apply = useCallback((seq: number, result: AndroidMachinePreferencesResult) => {
    confirm(seq, result.preferences);
    setPreferences(result.preferences);
    setRecordingsBytes(typeof result.recordingsBytes === "number" ? result.recordingsBytes : null);
    setError(null);
  }, [confirm]);

  const read = useCallback(async () => {
    if (!api?.getMachinePreferences) return;
    const seq = ++seqRef.current;
    setLoading(true);
    try {
      const result = await api.getMachinePreferences({}, pinRef.current);
      if (seq === seqRef.current) apply(seq, result);
    } catch (caught) {
      if (seq === seqRef.current) setError(describeAndroidError(caught));
    } finally {
      if (seq === seqRef.current) setLoading(false);
    }
  }, [api, apply]);

  useEffect(() => {
    confirmedRef.current = null;
    setPreferences(null);
    setRecordingsBytes(null);
    setError(null);
    void read();
  }, [read, pinKey]);

  useEffect(() => {
    if (!api || !listen) return;
    return api.onEvent((event) => {
      if (event.type !== "android.preferences.changed") return;
      // A write in flight owns the shown values until it answers.
      confirm(++seqRef.current, event.preferences);
      setPreferences(event.preferences);
      // The event carries no size; read it again for the meter.
      void read();
    }, pinRef.current);
  }, [api, confirm, listen, pinKey, read]);

  const update = useCallback((partial: Partial<AndroidMachinePreferences>) => {
    if (!api?.setMachinePreferences) return;
    const keys = Object.keys(partial) as (keyof AndroidMachinePreferences)[];
    if (keys.length === 0) return;
    const seq = ++seqRef.current;
    setPreferences((current) => (current ? { ...current, ...partial } : current));
    const writtenPin = pinRef.current;
    // The page shows another machine now: the reply is not for the shown values.
    const machineMoved = () => (pinRef.current?.key ?? null) !== (writtenPin?.key ?? null);
    void api.setMachinePreferences(partial, writtenPin).then(
      (result) => {
        if (machineMoved()) return;
        if (seq !== seqRef.current) {
          // A newer read or write owns the shown values. This reply is still
          // this machine's saved state, so a refused newer write goes back to
          // it, unless a newer answer already set that state.
          confirm(seq, result.preferences);
          return;
        }
        apply(seq, result);
      },
      (caught: unknown) => {
        if (machineMoved()) return;
        const confirmed = confirmedRef.current;
        if (confirmed) {
          setPreferences((current) => {
            if (!current) return current;
            const next = { ...current };
            for (const key of keys) {
              // Only a field still showing this write's value goes back; a newer write keeps its own.
              if (next[key] === partial[key]) (next as Record<string, unknown>)[key] = confirmed[key];
            }
            return next;
          });
        }
        const description = describeAndroidError(caught);
        const machine = machineNameRef.current;
        showToast({
          tone: "error",
          title: machine ? `Could not save the Android setting on ${machine}` : "Could not save the Android setting",
          message: description.sentence,
        });
      },
    );
  }, [api, apply, confirm]);

  return {
    preferences,
    recordingsBytes,
    error,
    unsupported: !canRead,
    loading,
    refresh: () => void read(),
    update,
  };
}
