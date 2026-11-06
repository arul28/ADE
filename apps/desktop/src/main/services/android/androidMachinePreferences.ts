import fs from "node:fs";
import path from "node:path";
import {
  DEFAULT_ANDROID_MACHINE_PREFERENCES,
  normalizeAndroidMachinePreferences,
  type AndroidMachinePreferences,
} from "../../../shared/types/androidEmulator";

/*
 * The machine's Android preferences (recording overlays, auto-record, the
 * storage warning, the remote bitrate cap), in the machine's Android
 * settings file (`<ADE home>/android/settings.json`) under `preferences`.
 *
 * The file also holds the SDK folder (`sdkPath`). Every write here reads
 * the file first and changes only its own keys, so a preferences write
 * keeps `sdkPath` and an SDK write keeps `preferences`.
 *
 * Node built-ins and relative imports only, so it runs under `tsx`.
 */

function readSettingsObject(file: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    // Missing or broken: the writer starts from empty, as the reader does.
    return {};
  }
}

/** Sets `keys` in the settings file and keeps every other key it holds. */
export function writeAndroidSettingsFileKeys(file: string, keys: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const body = { ...readSettingsObject(file), ...keys, updatedAt: new Date().toISOString() };
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(body, null, 2)}\n`, "utf8");
  fs.renameSync(temp, file);
}

export type AndroidMachinePreferenceStore = {
  read(): AndroidMachinePreferences;
  /** Merges `patch` over what is stored and answers the result. */
  write(patch: Partial<AndroidMachinePreferences>): AndroidMachinePreferences;
};

/**
 * The store over one settings file. With no file (a test host), the
 * preferences live in memory and start at the defaults.
 */
export function createAndroidMachinePreferenceStore(file: string | null | undefined): AndroidMachinePreferenceStore {
  let memory: AndroidMachinePreferences = { ...DEFAULT_ANDROID_MACHINE_PREFERENCES };
  let cache: { mtimeMs: number; value: AndroidMachinePreferences } | null = null;
  const read = (): AndroidMachinePreferences => {
    if (!file) return memory;
    try {
      const stat = fs.statSync(file);
      if (cache && cache.mtimeMs === stat.mtimeMs) return cache.value;
      const value = normalizeAndroidMachinePreferences(readSettingsObject(file).preferences);
      cache = { mtimeMs: stat.mtimeMs, value };
      return value;
    } catch {
      return { ...DEFAULT_ANDROID_MACHINE_PREFERENCES };
    }
  };
  return {
    read,
    write(patch) {
      const next = normalizeAndroidMachinePreferences(patch, read());
      if (!file) {
        memory = next;
        return next;
      }
      writeAndroidSettingsFileKeys(file, { preferences: next });
      cache = null;
      return next;
    },
  };
}
