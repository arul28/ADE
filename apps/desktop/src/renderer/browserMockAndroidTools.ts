import type {
  AndroidAppInfo,
  AndroidDeviceSettings,
  AndroidEmulatorToolsPreloadApi,
  AndroidRecording,
  AndroidUiSnapshot,
} from "../shared/types/androidEmulator";

/*
 * The browser preview's Tools drawer, Inspect and Record: a fake emulator
 * that keeps its settings, apps and recordings in memory.
 * `?mockAndroidTools=fail` makes every change refuse, to see the error banner.
 */

const DISPLAY_SCALE = { small: 0.85, default: 1, large: 1.15, larger: 1.3 } as const;
const TEXT_SCALE = { small: 0.85, default: 1, large: 1.15, largest: 1.3 } as const;

export function createMockAndroidTools({ fail }: { fail: boolean }): AndroidEmulatorToolsPreloadApi {
  const delay = <T,>(value: T, ms = 160) => new Promise<T>((resolve) => window.setTimeout(() => resolve(value), ms));
  const refuse = (what: string) => Promise.reject(new Error(`ANDROID_DEVICE_NOT_BOOTED: The mock emulator refused ${what}.`));
  let foreground: string | null = null;
  const apps: AndroidAppInfo[] = [
    { packageName: "com.example.sample", launchActivity: "com.example.sample/.MainActivity", adeInstalled: true },
    { packageName: "com.android.chrome", launchActivity: "com.android.chrome/com.google.android.apps.chrome.Main", adeInstalled: false },
    { packageName: "com.android.settings", launchActivity: "com.android.settings/.Settings", adeInstalled: false },
  ];
  const recordings: AndroidRecording[] = [{
    id: "rec-1",
    laneId: "lane",
    chatSessionId: "chat-1",
    label: "Sign-in flow",
    path: "/Users/mock/.ade/android/recordings/rec-1.mp4",
    segments: [],
    startedAt: "2026-11-05T09:12:00.000Z",
    endedAt: "2026-11-05T09:12:41.000Z",
    durationMs: 41_000,
    bytes: 3_400_000,
    active: false,
    stopReason: "requested",
    proofArtifactIds: ["mock-proof-rec-1"],
    lastError: null,
  }];
  let settings: Omit<AndroidDeviceSettings, "laneId" | "foregroundPackage"> = {
    appearance: "light",
    fontScale: 1,
    textSize: "default",
    density: { physical: 420, override: null },
    displaySize: "default",
    animationsOff: false,
    showTaps: false,
    layoutBounds: false,
    battery: { level: 100, charging: true },
    network: { wifi: true, mobileData: true, airplane: false },
  };
  const read = (laneId: string): AndroidDeviceSettings => ({ ...settings, laneId, foregroundPackage: foreground });
  const change = <T,>(what: string, apply: () => T): Promise<T> => (fail ? refuse(what) : delay(apply()));

  const snapshot = (laneId: string): AndroidUiSnapshot => ({
    laneId,
    source: "uiautomator",
    capturedAt: new Date().toISOString(),
    durationMs: 420,
    cached: false,
    width: 1080,
    height: 2400,
    foregroundPackage: foreground,
    elements: [],
  });

  return {
    listApps: async ({ laneId }) => delay({ laneId, apps }),
    installApp: async ({ laneId, apkPath }) => change("the install", () => ({
      laneId,
      packageName: "com.example.sample",
      method: apkPath ? "apk" as const : "gradle" as const,
      apkPath: apkPath ?? "app/build/outputs/apk/debug/app-debug.apk",
      gradleTask: apkPath ? null : ":app:installDebug",
      durationMs: 9_400,
      outputTail: ["BUILD SUCCESSFUL in 9s"],
    })),
    launchApp: async ({ laneId, packageName, gradle }) => change("the launch", () => {
      foreground = packageName ?? "com.example.sample";
      return {
        laneId,
        packageName: foreground,
        activity: `${foreground}/.MainActivity`,
        install: gradle ? { laneId, packageName: foreground, method: "gradle" as const, apkPath: null, gradleTask: ":app:installDebug", durationMs: 9_400, outputTail: [] } : null,
        totalTimeMs: 610,
      };
    }),
    terminateApp: async ({ laneId, packageName }) => change("the stop", () => {
      if (foreground === packageName) foreground = null;
      return { laneId, packageName };
    }),
    uninstallApp: async ({ laneId, packageName }) => change("the uninstall", () => {
      const index = apps.findIndex((app) => app.packageName === packageName);
      if (index >= 0) apps.splice(index, 1);
      if (foreground === packageName) foreground = null;
      return { laneId, packageName, uninstalled: index >= 0 };
    }),
    openUrl: async ({ laneId, url }) => change("the link", () => {
      foreground = "com.android.chrome";
      return { laneId, url };
    }),
    getScreenSnapshot: async ({ laneId }) => delay(snapshot(laneId), 300),
    recordStart: async ({ laneId }) => change("the recording", () => ({ ...recordings[0]!, id: "rec-live", laneId, active: true, endedAt: null })),
    recordStop: async ({ laneId }) => change("the stop", () => {
      const done = { ...recordings[0]!, id: `rec-${recordings.length + 1}`, laneId, label: null, startedAt: new Date().toISOString() };
      recordings.unshift(done);
      return done;
    }),
    recordList: async ({ laneId }) => delay({ laneId, recordings: recordings.map((entry) => ({ ...entry, laneId })) }),
    recordDelete: async ({ laneId, id }) => {
      const index = recordings.findIndex((entry) => entry.id === id);
      if (index >= 0) recordings.splice(index, 1);
      return delay({ laneId, id, deleted: index >= 0 });
    },
    setLocation: async ({ laneId, latitude, longitude }) => change("the location", () => ({ laneId, latitude, longitude })),
    setAppearance: async ({ laneId, appearance }) => change("the appearance", () => {
      settings = { ...settings, appearance };
      return { laneId, appearance };
    }),
    setPermission: async ({ laneId, action, packageName, permission }) => change("the permission", () => ({ laneId, action, packageName, permission })),
    getDeviceSettings: async ({ laneId }) => delay(read(laneId), 120),
    setDeviceSetting: async ({ laneId, setting }) => change("the setting", () => {
      switch (setting.kind) {
        case "text-size": settings = { ...settings, textSize: setting.value, fontScale: TEXT_SCALE[setting.value] }; break;
        case "display-size": settings = {
          ...settings,
          displaySize: setting.value,
          density: { physical: 420, override: setting.value === "default" ? null : Math.round(420 * DISPLAY_SCALE[setting.value]) },
        }; break;
        case "animations": settings = { ...settings, animationsOff: setting.off }; break;
        case "show-taps": settings = { ...settings, showTaps: setting.on }; break;
        case "layout-bounds": settings = { ...settings, layoutBounds: setting.on }; break;
        case "battery": settings = {
          ...settings,
          battery: { level: setting.level ?? settings.battery.level, charging: setting.charging ?? settings.battery.charging },
        }; break;
        case "wifi": settings = { ...settings, network: { ...settings.network, wifi: setting.on } }; break;
        case "mobile-data": settings = { ...settings, network: { ...settings.network, mobileData: setting.on } }; break;
        case "airplane": settings = { ...settings, network: { ...settings.network, airplane: setting.on } }; break;
      }
      return read(laneId);
    }),
  };
}
