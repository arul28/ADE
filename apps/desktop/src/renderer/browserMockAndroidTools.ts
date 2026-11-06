import type {
  AndroidAppInfo,
  AndroidDeviceSettings,
  AndroidEmulatorToolsPreloadApi,
  AndroidPosture,
  AndroidRecording,
  AndroidUiSnapshot,
} from "../shared/types/androidEmulator";
import { ANDROID_FOLD_POSE_ANGLES } from "../shared/types/androidEmulator";

/*
 * The browser preview's Tools drawer, Inspect and Record: a fake emulator
 * that keeps its settings, apps and recordings in memory.
 * `?mockAndroidTools=fail` makes every change refuse, to see the error banner.
 */

const DISPLAY_SCALE = { small: 0.85, default: 1, large: 1.15, larger: 1.3 } as const;
const TEXT_SCALE = { small: 0.85, default: 1, large: 1.15, largest: 1.3 } as const;

/**
 * P3's System images and "Run tests" come from `browserMockAndroidImages.ts`;
 * "Keep running" from `browserMockAndroid.ts`, which keeps the lane's state.
 */
type MockToolsApi = Omit<
  AndroidEmulatorToolsPreloadApi,
  "listSystemImages" | "installSystemImage" | "removeSystemImage" | "runInstrumentationTests" | "setKeepRunning"
>;

const MOCK_PREVIEWS = [
  { fqn: "com.example.sample.ui.GreetingKt.GreetingPreview", name: "Light", dark: false },
  { fqn: "com.example.sample.ui.GreetingKt.GreetingDarkPreview", name: "Dark", dark: true },
  { fqn: "com.example.sample.ui.SignInKt.SignInScreenPreview", name: null, dark: false },
] as const;

/** A preview card as an SVG `data:` URL. */
function mockPreviewImage(label: string, dark: boolean): string {
  const [bg, fg] = dark ? ["#1c1b1f", "#e6e1e5"] : ["#fffbfe", "#1c1b1f"];
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><rect width="320" height="180" rx="16" fill="${bg}"/>`
    + `<text x="24" y="96" font-family="sans-serif" font-size="22" fill="${fg}">Hello, ${label}!</text></svg>`;
  return `data:image/svg+xml;base64,${btoa(svg)}`;
}

export function createMockAndroidTools({ fail }: { fail: boolean }): MockToolsApi {
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
  // The fold: the Pixel Fold's ranges (shut below 30°, open from 150°) and screens.
  let hingeAngle = 180;
  const posture = (laneId: string): AndroidPosture => ({
    laneId,
    supported: true,
    angle: hingeAngle,
    state: hingeAngle < 30 ? "closed" : hingeAngle < 150 ? "half-open" : "open",
    screen: hingeAngle < 30 ? { width: 1080, height: 2364 } : { width: 2076, height: 2152 },
  });
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
    getPosture: async ({ laneId }) => delay(posture(laneId)),
    setPosture: async ({ laneId, angle, pose }) => change("the fold", () => {
      hingeAngle = typeof angle === "number" ? angle : ANDROID_FOLD_POSE_ANGLES[pose ?? "open"];
      return { ...posture(laneId), settled: true };
    }),
    // P3 Compose previews: three previews, each drawn as a small card.
    listComposePreviews: async ({ laneId, module }) => change("the preview list", () => ({
      laneId,
      module: module ?? "app",
      previews: MOCK_PREVIEWS.map((preview) => ({ ...preview, params: {} })),
    })),
    renderComposePreviews: async ({ laneId, module, fqns }) => change("the preview render", () => {
      const wanted = MOCK_PREVIEWS.filter((preview) => !fqns?.length || fqns.includes(preview.fqn));
      return {
        laneId,
        module: module ?? "app",
        outDir: "/Users/mock/.ade/android/compose-previews/lane/2026-11-05",
        images: wanted.map((preview) => ({
          fqn: preview.fqn,
          name: preview.name,
          path: `/Users/mock/.ade/android/compose-previews/lane/${preview.fqn}.png`,
          proofArtifactId: `mock-proof-${preview.fqn}`,
          dataUrl: mockPreviewImage(preview.name ?? preview.fqn, preview.dark),
          error: null,
        })),
        skipped: 0,
        durationMs: 18_400,
      };
    }),
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
    // The Logs group: a few new lines on each read after the cursor.
    readLog: async ({ laneId, packageName, since }) => {
      const start = since ? Number(since) : Date.now() / 1000 - 30;
      const tags = ["MainActivity", "OkHttp", "SignInViewModel"] as const;
      const lines = Array.from({ length: since ? 2 : 12 }, (_, index) => ({
        time: (start + (index + 1) * 0.25).toFixed(3),
        pid: 4321,
        tid: 4321 + (index % 3),
        level: (["D", "I", "W", "E"] as const)[index % 4]!,
        tag: tags[index % tags.length]!,
        message: index % 4 === 3 ? "Sign-in failed: HTTP 401" : `Step ${index + 1} done`,
      }));
      return delay({ laneId, packageName: packageName ?? null, pids: [4321], lines, truncated: false, cursor: lines.at(-1)?.time ?? since ?? null }, 120);
    },
  };
}
