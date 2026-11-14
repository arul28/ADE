import os from "node:os";
import type {
  AndroidEmulatorEvent,
  AndroidEmulatorServiceApi,
  AndroidEmulatorStatus,
  AndroidSdkStatus,
} from "../../../shared/types/androidEmulator";
import type { ANDROID_MACHINE_ACTIONS } from "../../../shared/machineScope";
import type { Logger } from "../logging/logger";
import { getErrorMessage } from "../shared/utils";
import { readAndroidSdkStatus } from "./androidSdk";
import { createAndroidSdkSetup, createAndroidSdkSettingStore } from "./androidSdkSetup";
import { createAndroidMachinePreferenceStore, createAndroidSettingsFile } from "./androidMachinePreferences";

/*
 * A computer's own Android settings with no project: Settings › Android
 * devices on the machine route (`shared/machineScope.ts`).
 *
 * Everything on that page but the recordings meter belongs to the machine:
 * the SDK and its guided install (one installer per machine, shared with
 * every project's emulator service) and the machine preferences, all in
 * `<ADE home>/android/settings.json`. Lanes, devices and recordings are a
 * project's, so this has none of them; the machine scope answers only
 * `ANDROID_MACHINE_ACTIONS`.
 *
 * Node built-ins and relative imports only, so it runs in the brain.
 */

/** The `android_emulator` actions a computer answers with no project (`ANDROID_MACHINE_ACTIONS`). */
export type AndroidMachineSettingsService =
  Pick<AndroidEmulatorServiceApi, (typeof ANDROID_MACHINE_ACTIONS)[number]> & { dispose(): void };

export function createAndroidMachineSettingsService(deps: {
  /** `<ADE home>/android/settings.json`, the file every project's emulator service reads. */
  sdkSettingsFile: string;
  logger?: Logger | null;
  onEvent: (event: AndroidEmulatorEvent) => void;
  platform?: NodeJS.Platform;
  env?: Readonly<Record<string, string | undefined>>;
  home?: string;
}): AndroidMachineSettingsService {
  const logger = deps.logger ?? null;
  const platform = deps.platform ?? process.platform;
  const env = deps.env ?? process.env;
  const home = deps.home ?? os.homedir();
  const platformSupported = platform === "darwin" || platform === "win32" || platform === "linux";
  const unsupportedReason = platformSupported
    ? null
    : `The Android emulator runs on macOS, Windows and Linux, not on ${platform}.`;
  const settingsFile = createAndroidSettingsFile(deps.sdkSettingsFile, logger);
  const sdkSettings = createAndroidSdkSettingStore(settingsFile);
  const preferences = createAndroidMachinePreferenceStore(settingsFile);
  const emit = (event: AndroidEmulatorEvent): void => {
    try {
      deps.onEvent(event);
    } catch (error) {
      logger?.warn("android.event_forward_failed", { error: getErrorMessage(error) });
    }
  };
  // The same change signal the emulator service gives: the page reads again
  // when the SDK it shows is no longer the SDK on disk.
  let lastSdkKey: string | null = null;
  const readSdk = async (options: { forceAccelCheck?: boolean } = {}): Promise<AndroidSdkStatus> => {
    const sdk = await readAndroidSdkStatus({ settingPath: sdkSettings.read(), env, platform, home, forceAccelCheck: options.forceAccelCheck });
    const key = JSON.stringify([sdk.found, sdk.root, sdk.tools.map((tool) => [tool.id, tool.available]), sdk.acceleration.usable]);
    if (lastSdkKey !== null && key !== lastSdkKey) emit({ type: "android.sdk.changed" });
    lastSdkKey = key;
    return sdk;
  };
  const getStatus = async (): Promise<AndroidEmulatorStatus> => ({
    platformSupported,
    unsupportedReason,
    sdk: await readSdk(),
    lane: null,
    capabilities: null,
  });
  const setup = createAndroidSdkSetup({ readSdk, getStatus, settings: sdkSettings, emit, logger, platform, env, home });
  return {
    getStatus,
    getSdkSetupPlan: setup.getSdkSetupPlan,
    installSdk: setup.installSdk,
    cancelSdkInstall: setup.cancelSdkInstall,
    getSdkInstallState: setup.getSdkInstallState,
    setSdkPath: setup.setSdkPath,
    // Recordings are a project's: null tells the page to say so.
    async getMachinePreferences() {
      return { preferences: preferences.read(), recordingsBytes: null };
    },
    async setMachinePreferences(args) {
      const next = preferences.write(args ?? {});
      logger?.info("android.preferences_set", { keys: Object.keys(args ?? {}) });
      emit({ type: "android.preferences.changed", preferences: next });
      return { preferences: next, recordingsBytes: null };
    },
    dispose: () => setup.dispose(),
  };
}
