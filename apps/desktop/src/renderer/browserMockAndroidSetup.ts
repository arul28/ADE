/**
 * The setup card's half of the Android mock (`browserMockAndroid.ts`): a plan
 * from the mock SDK and an install that plays its progress as
 * `android.sdk.install` events, about 10 s from start to done.
 *
 * `?mockAndroidSetup=<case>` picks a harder case to look at:
 *
 * - `offline`: Google's repository is not reachable.
 * - `nospace`: the install folder's drive is nearly full.
 * - `readonly`: ADE cannot write to the install folder.
 * - `fail`: the phone image download fails half way.
 * - `arm`: a Windows-on-Arm host, which Google has no emulator for.
 */

import type {
  AndroidEmulatorEvent,
  AndroidEmulatorSetupPreloadApi,
  AndroidEmulatorStatus,
  AndroidSdkInstallState,
  AndroidSdkLicense,
  AndroidSdkSetupPart,
  AndroidSdkSetupPartId,
  AndroidSdkSetupPlan,
  AndroidSdkStatus,
} from "../shared/types/androidEmulator";

type SetupCase = "normal" | "offline" | "nospace" | "readonly" | "fail" | "arm";

function setupCase(): SetupCase {
  try {
    const value = new URLSearchParams(window.location.search).get("mockAndroidSetup");
    const known: SetupCase[] = ["offline", "nospace", "readonly", "fail", "arm"];
    return known.includes(value as SetupCase) ? (value as SetupCase) : "normal";
  } catch {
    return "normal";
  }
}

const DEFAULT_ROOT = "/Users/mock/Library/Android/sdk";

const LICENSE_TEXT = `Terms and Conditions

This is the Android Software Development Kit License Agreement

1. Introduction

1.1 The Android Software Development Kit (referred to in the License Agreement as the "SDK" and specifically including the Android system files, packaged APIs, and Google APIs add-ons) is licensed to you subject to the terms of the License Agreement. The License Agreement forms a legally binding contract between you and Google in relation to your use of the SDK.

1.2 "Android" means the Android software stack for devices, as made available under the Android Open Source Project.

(The mock shows the start of the text. The real card shows Google's full text from the repository manifest.)`;

type MockPart = Omit<AndroidSdkSetupPart, "installedVersion" | "missing"> & { found: string | null };

const PARTS: MockPart[] = [
  { id: "platform-tools", label: "Platform tools", packagePath: "platform-tools", version: "37.0.1", found: "36.0.0", optional: false, downloadBytes: 16e6, installedBytes: 40e6, licenseId: "android-sdk-license", detail: "adb" },
  { id: "cmdline-tools", label: "Command-line tools", packagePath: "cmdline-tools;latest", version: "23.0", found: null, optional: false, downloadBytes: 155e6, installedBytes: 190e6, licenseId: "android-sdk-license", detail: "Device profiles" },
  { id: "emulator", label: "Emulator", packagePath: "emulator", version: "37.2.13", found: "37.1.11", optional: false, downloadBytes: 416e6, installedBytes: 1.1e9, licenseId: "android-sdk-license", detail: null },
  { id: "system-image", label: "Phone image", packagePath: "system-images;android-37.0;google_apis_playstore;arm64-v8a", version: "8", found: "API 36 google_apis_playstore", optional: false, downloadBytes: 2.17e9, installedBytes: 6.5e9, licenseId: "android-sdk-arm-dbt-license", detail: "API 37 · Google Play · arm64" },
];

export function createMockAndroidSetup(deps: {
  /** The SDK the rest of the mock reports; the install makes it whole. */
  sdk: () => AndroidSdkStatus;
  status: () => AndroidEmulatorStatus;
  emit: (event: AndroidEmulatorEvent) => void;
  onInstalled: (root: string) => void;
  onUseSdk: (root: string | null) => void;
}): AndroidEmulatorSetupPreloadApi {
  const which = setupCase();
  const installed = new Set<AndroidSdkSetupPartId>();
  let cliInstalled = false;
  let install: AndroidSdkInstallState = { state: "idle" };
  let timer: number | null = null;
  let downloadedBefore = 0;
  const accepted = new Set<string>();

  const parts = (root: string, withCli: boolean): AndroidSdkSetupPart[] => {
    const sdk = deps.sdk();
    const sameRoot = sdk.found && sdk.root === root;
    const list: AndroidSdkSetupPart[] = PARTS.map(({ found, ...part }) => {
      const tool = sdk.tools.find((entry) => entry.id === part.id);
      const have = installed.has(part.id) ? (part.id === "system-image" ? "API 37 google_apis_playstore" : part.version) : sameRoot && tool?.available ? tool.version ?? found : null;
      // The found emulator is older than the API 37 image needs.
      const stale = part.id === "emulator" && have !== null && have !== part.version && !installed.has("emulator");
      return {
        ...part,
        installedVersion: have,
        missing: have === null || stale,
        detail: stale ? `Update from ${have}` : part.detail,
        version: which === "offline" ? null : part.version,
        downloadBytes: which === "offline" ? 0 : part.downloadBytes,
      };
    });
    list.push({
      id: "android-cli",
      label: "Android CLI",
      packagePath: null,
      version: cliInstalled ? "1.1.16717390" : null,
      installedVersion: cliInstalled ? "1.1.16717390" : null,
      missing: !cliInstalled && withCli && which !== "arm",
      optional: true,
      downloadBytes: cliInstalled || which === "arm" ? 0 : 3.7e6,
      installedBytes: cliInstalled || which === "arm" ? 0 : 160e6,
      licenseId: "android-cli-terms",
      detail: cliInstalled ? "Installed by ADE" : which === "arm" ? "Not available for this computer" : "Optional · UI tree, Compose previews",
    });
    return list;
  };

  const plan = (args?: { sdkRoot?: string | null; includeAndroidCli?: boolean }): AndroidSdkSetupPlan => {
    const sdk = deps.sdk();
    const chosen = args?.sdkRoot?.trim() || null;
    const sdkRoot = chosen ?? (sdk.found && sdk.root ? sdk.root : DEFAULT_ROOT);
    const all = parts(sdkRoot, args?.includeAndroidCli ?? false);
    const missing = which === "arm" ? [] : all.filter((part) => part.missing);
    const licenseIds = [...new Set(missing.map((part) => part.licenseId).filter((id): id is string => Boolean(id)))];
    const licenses: AndroidSdkLicense[] = which === "offline" ? [] : licenseIds.map((id) => ({
      id,
      title: id === "android-sdk-arm-dbt-license" ? "Android SDK Arm license" : id === "android-cli-terms" ? "Android CLI terms" : "Android SDK License",
      text: LICENSE_TEXT,
      accepted: accepted.has(id),
      partIds: missing.filter((part) => part.licenseId === id).map((part) => part.id),
    }));
    const downloadBytes = missing.reduce((sum, part) => sum + part.downloadBytes, 0);
    return {
      hostSupported: which !== "arm",
      unsupportedReason: which === "arm" ? "Google publishes no Android emulator for Windows on Arm. ADE cannot set up Android on this machine." : null,
      sdkRoot,
      sdkRootSource: chosen ? "chosen" : sdk.found ? "found" : "default",
      existingSdkRoot: sdk.found && sdk.root === sdkRoot ? sdk.root : null,
      parts: all,
      licenses,
      downloadBytes,
      diskBytesNeeded: missing.reduce((sum, part) => sum + part.installedBytes, 0) + Math.max(0, ...missing.map((part) => part.downloadBytes)),
      diskBytesFree: which === "nospace" ? 3.1e9 : 412e9,
      writable: which !== "readonly",
      writableDetail: which === "readonly" ? `Permission denied: ${sdkRoot}` : null,
      avdHome: sdk.avdHome,
      avdHomeFreeBytes: which === "nospace" ? 3.1e9 : 412e9,
      acceleration: sdk.acceleration,
      repositoryError: which === "offline" ? "Google's SDK repository could not be read: getaddrinfo ENOTFOUND dl.google.com" : null,
      install,
      checkedAt: new Date().toISOString(),
    };
  };

  const set = (next: AndroidSdkInstallState) => {
    install = next;
    deps.emit({ type: "android.sdk.install", install: next });
  };

  const finish = (next: AndroidSdkInstallState) => {
    if (timer !== null) window.clearInterval(timer);
    timer = null;
    set(next);
    if (next.state === "done") deps.onInstalled(next.sdkRoot);
    deps.emit({ type: "android.sdk.changed" });
  };

  const delay = <T,>(value: T, ms = 140) => new Promise<T>((resolve) => window.setTimeout(() => resolve(value), ms));

  return {
    getSdkSetupPlan: async (args) => delay(plan(args), 260),
    installSdk: async (args) => {
      if (install.state === "running") throw new Error("ANDROID_SDK_INSTALL_BUSY: An Android SDK install already runs on this machine.");
      const current = plan(args);
      const missingConsent = current.licenses.filter((license) => !args.acceptedLicenseIds.includes(license.id));
      if (missingConsent.length > 0) throw new Error(`ANDROID_SDK_LICENSE_NOT_ACCEPTED: Accept ${missingConsent.map((license) => license.title).join(" and ")} before the install.`);
      if (current.diskBytesFree !== null && current.diskBytesFree < current.diskBytesNeeded) {
        throw new Error("ANDROID_SDK_NO_SPACE: The install needs more space than that drive has free.");
      }
      for (const id of args.acceptedLicenseIds) accepted.add(id);
      const queue = current.parts.filter((part) => part.missing);
      const jobId = `mock-${Date.now()}`;
      const startedAt = new Date().toISOString();
      const overallTotal = queue.reduce((sum, part) => sum + part.downloadBytes, 0);
      let index = 0;
      let done = downloadedBefore;
      let base = 0;
      let unpackTicks = 0;
      const tick = () => {
        const part = queue[index];
        if (!part) {
          finish({ state: "done", jobId, sdkRoot: current.sdkRoot, finishedAt: new Date().toISOString(), installed: queue.map((entry) => entry.id) });
          return;
        }
        if (install.state === "running" && install.cancelling) {
          downloadedBefore = done;
          finish({ state: "cancelled", jobId, sdkRoot: current.sdkRoot, finishedAt: new Date().toISOString(), installed: queue.slice(0, index).map((entry) => entry.id) });
          return;
        }
        const running = (step: "download" | "unpack", bytesDone: number) => set({
          state: "running", jobId, sdkRoot: current.sdkRoot, startedAt, step, partId: part.id, partLabel: part.label,
          partIndex: index, partCount: queue.length, bytesDone, bytesTotal: part.downloadBytes,
          overallDone: base + (step === "download" ? bytesDone : part.downloadBytes), overallTotal,
          etaSeconds: Math.max(1, Math.round((overallTotal - base - bytesDone) / 400e6)), cancelling: false,
        });
        if (done < part.downloadBytes) {
          done = Math.min(part.downloadBytes, done + 400e6 / 4);
          if (which === "fail" && part.id === "system-image" && done > part.downloadBytes / 2) {
            finish({
              state: "failed", jobId, sdkRoot: current.sdkRoot, finishedAt: new Date().toISOString(), partId: part.id,
              error: { code: "ANDROID_SDK_INSTALL_FAILED", message: "Phone image failed: the download stopped after 4 attempts (ECONNRESET)." },
              installed: queue.slice(0, index).map((entry) => entry.id),
            });
            return;
          }
          running("download", done);
          return;
        }
        if (unpackTicks < 3) {
          unpackTicks += 1;
          running("unpack", Math.round((part.downloadBytes * unpackTicks) / 3));
          return;
        }
        if (part.id === "android-cli") cliInstalled = true;
        else installed.add(part.id);
        base += part.downloadBytes;
        index += 1;
        done = 0;
        unpackTicks = 0;
      };
      downloadedBefore = 0;
      tick();
      timer = window.setInterval(tick, 250);
      return install;
    },
    cancelSdkInstall: async () => {
      if (install.state === "running") set({ ...install, cancelling: true });
      return delay(install, 60);
    },
    getSdkInstallState: async () => delay(install, 60),
    setSdkPath: async (args) => {
      if (args.path !== null && !/sdk/iu.test(args.path)) {
        throw new Error(`ANDROID_SDK_PATH_INVALID: ${args.path} is not an Android SDK. Pick the folder that holds platform-tools, emulator or system-images.`);
      }
      deps.onUseSdk(args.path);
      deps.emit({ type: "android.sdk.changed" });
      return delay(deps.status(), 120);
    },
  };
}
