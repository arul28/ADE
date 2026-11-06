import type {
  AndroidEmulatorEvent,
  AndroidMachinePreferences,
  AndroidMachinePreferencesResult,
} from "../shared/types/androidEmulator";
import {
  DEFAULT_ANDROID_MACHINE_PREFERENCES,
  normalizeAndroidMachinePreferences,
} from "../shared/types/androidEmulator";
import type { OpenProjectBinding } from "../shared/types";

/*
 * The browser preview's machine preferences (Settings › Android devices):
 * one in-memory set per machine, keyed by the pin (none = this machine), as
 * each brain keeps its own. A write to this machine emits
 * `android.preferences.changed` (the mock's one event bus has no machines).
 *
 * - `?mockAndroidRecordingsBytes=<bytes>`: this project's recordings on every
 *   machine (default 1.2 GiB). `none` answers null (cannot count).
 * - `?mockAndroidPrefs=fail`: every write refuses, to see the rollback and
 *   its toast. `?mockAndroidPrefs=old` refuses reads too, as an older ADE
 *   on that machine (with no such action) would.
 */

const GIB = 1024 ** 3;

function param(name: string): string | null {
  try {
    return new URLSearchParams(window.location.search).get(name);
  } catch {
    return null;
  }
}

function recordingsBytes(): number | null {
  const raw = param("mockAndroidRecordingsBytes");
  if (raw === "none") return null;
  const value = raw == null ? Number.NaN : Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : Math.round(1.2 * GIB);
}

export type MockAndroidPreferencesApi = {
  getMachinePreferences: (args?: Record<string, never> | null, pin?: OpenProjectBinding | null) => Promise<AndroidMachinePreferencesResult>;
  setMachinePreferences: (args: Partial<AndroidMachinePreferences>, pin?: OpenProjectBinding | null) => Promise<AndroidMachinePreferencesResult>;
};

export function createMockAndroidPreferences(input: {
  emit: (event: AndroidEmulatorEvent) => void;
}): MockAndroidPreferencesApi {
  // Read once: the app's router drops the query string on its first navigation.
  const mode = param("mockAndroidPrefs");
  const bytes = recordingsBytes();
  const byMachine = new Map<string, AndroidMachinePreferences>();
  const read = (pin: OpenProjectBinding | null | undefined): AndroidMachinePreferences =>
    byMachine.get(pin?.key ?? "") ?? { ...DEFAULT_ANDROID_MACHINE_PREFERENCES };
  const answer = (preferences: AndroidMachinePreferences): AndroidMachinePreferencesResult => ({
    preferences,
    recordingsBytes: bytes,
  });
  const later = <T,>(value: T, ms: number) => new Promise<T>((resolve) => setTimeout(() => resolve(value), ms));
  return {
    getMachinePreferences: async (_args, pin) => {
      if (mode === "old") throw new Error("Unknown action android_emulator.getMachinePreferences (mock).");
      return later(answer(read(pin)), 80);
    },
    setMachinePreferences: async (partial, pin) => {
      await later(null, 120);
      if (mode === "fail" || mode === "old") throw new Error("The machine refused the change (mock).");
      const next = normalizeAndroidMachinePreferences(partial, read(pin));
      byMachine.set(pin?.key ?? "", next);
      // The mock's event bus has no machines, so only this machine's writes announce themselves.
      if (!pin) input.emit({ type: "android.preferences.changed", preferences: next });
      return answer(next);
    },
  };
}
