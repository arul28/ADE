/**
 * The P3 half of the Android mock (`browserMockAndroid.ts`): the device
 * picker's System images and the drawer's "Run tests".
 *
 * An image install plays its progress as `android.sdk.install` events on the
 * same job the setup card uses (so one install at a time), about 4 s from
 * start to done. A new image then shows in `listDevices`, as on a real brain.
 *
 * - `?mockAndroidImages=fail`: an install fails half way.
 * - `?mockAndroidTests=fail`: the test run has failures.
 */

import type {
  AndroidAvdListing,
  AndroidEmulatorEvent,
  AndroidEmulatorSetupPreloadApi,
  AndroidInstrumentationTestResult,
  AndroidSdkInstallState,
  AndroidSdkLicense,
  AndroidSystemImage,
  AndroidSystemImageEntry,
  AndroidSystemImageInventory,
  AndroidToolsPreloadMethod,
} from "../shared/types/androidEmulator";
import { mockParam } from "./browserMockAndroidUtil";

const ROOT = "/Users/mock/Library/Android/sdk";
const LICENSE_TEXT = `Terms and Conditions

This is the Android Software Development Kit License Agreement (mock text for the browser preview).
1.1 The Android Software Development Kit is licensed to you subject to the terms of this License Agreement.`;

type MockImage = {
  id: string;
  apiLevel: number;
  tag: "google_apis_playstore" | "google_apis";
  installed: boolean;
  sizeBytes: number;
  downloadBytes: number;
  licenseId: string;
};

function imageName(image: MockImage): string {
  return `API ${image.apiLevel} · ${image.tag === "google_apis_playstore" ? "Google Play" : "Google APIs"} · arm64`;
}

export function createMockAndroidImages(deps: {
  setup: AndroidEmulatorSetupPreloadApi;
  emit: (event: AndroidEmulatorEvent) => void;
  /** Every AVD the mock lists, to say which ones use an image. */
  avds: () => AndroidAvdListing[];
}): {
  api: {
    listSystemImages: AndroidToolsPreloadMethod<"listSystemImages">;
    installSystemImage: AndroidToolsPreloadMethod<"installSystemImage">;
    removeSystemImage: AndroidToolsPreloadMethod<"removeSystemImage">;
    runInstrumentationTests: AndroidToolsPreloadMethod<"runInstrumentationTests">;
    getSdkInstallState: AndroidEmulatorSetupPreloadApi["getSdkInstallState"];
    cancelSdkInstall: AndroidEmulatorSetupPreloadApi["cancelSdkInstall"];
  };
  /** The installed images (the base one, then each mock install), for `listDevices`. */
  installed: () => AndroidSystemImage[];
} {
  const delay = <T,>(value: T, ms = 160) => new Promise<T>((resolve) => window.setTimeout(() => resolve(value), ms));
  // Read once: the app's router drops the query string after the first load.
  const failInstall = mockParam("mockAndroidImages") === "fail";
  const failingTests = mockParam("mockAndroidTests") === "fail";
  // API 36 Play is the base mock's IMAGE (always installed); the rest start as offers.
  const images: MockImage[] = [
    { id: "system-images;android-36;google_apis_playstore;arm64-v8a", apiLevel: 36, tag: "google_apis_playstore", installed: true, sizeBytes: 6.1e9, downloadBytes: 1.9e9, licenseId: "android-sdk-arm-dbt-license" },
    { id: "system-images;android-37.0;google_apis_playstore;arm64-v8a", apiLevel: 37, tag: "google_apis_playstore", installed: false, sizeBytes: 6.4e9, downloadBytes: 2.1e9, licenseId: "android-sdk-arm-dbt-license" },
    { id: "system-images;android-35;google_apis;arm64-v8a", apiLevel: 35, tag: "google_apis", installed: false, sizeBytes: 4.6e9, downloadBytes: 1.6e9, licenseId: "android-sdk-license" },
    { id: "system-images;android-34;google_apis_playstore;arm64-v8a", apiLevel: 34, tag: "google_apis_playstore", installed: false, sizeBytes: 5.2e9, downloadBytes: 1.7e9, licenseId: "android-sdk-arm-dbt-license" },
  ];
  const accepted = new Set<string>();
  let job: AndroidSdkInstallState = { state: "idle" };
  let installingId: string | null = null;
  let timer: number | null = null;

  const set = (next: AndroidSdkInstallState) => {
    job = next;
    deps.emit({ type: "android.sdk.install", install: next });
  };
  const avdsFor = (image: MockImage) =>
    image.id.includes("android-36;google_apis_playstore")
      ? deps.avds().filter((avd) => (avd.apiLevel ?? 36) === 36).map((avd) => ({
        name: avd.name,
        displayName: avd.displayName,
        adeCreated: avd.adeCreated,
        heldByLaneId: avd.heldByLaneId,
        running: Boolean(avd.running),
      }))
      : [];
  const newestId = () => [...images].filter((image) => image.installed).sort((a, b) => b.apiLevel - a.apiLevel)[0]?.id ?? null;
  const entry = (image: MockImage): AndroidSystemImageEntry => ({
    id: image.id,
    apiLevel: image.apiLevel,
    platform: image.id.split(";")[1]!,
    tag: image.tag,
    abi: "arm64-v8a",
    name: imageName(image),
    installed: image.installed,
    path: image.installed ? `${ROOT}/${image.id.split(";").join("/")}` : null,
    installedRevision: image.installed ? "7" : null,
    sizeBytes: image.installed ? image.sizeBytes : null,
    avds: avdsFor(image),
    newest: image.id === newestId(),
    hostAbi: true,
    available: { revision: "7", downloadBytes: image.downloadBytes, installedBytes: image.sizeBytes, licenseId: image.licenseId, needsEmulator: "36.1.9" },
    updateAvailable: false,
    emulatorTooOld: false,
  });
  const inventory = async (): Promise<AndroidSystemImageInventory> => {
    const setupJob = await deps.setup.getSdkInstallState({});
    const install = job.state === "running" ? job : setupJob.state === "running" ? setupJob : job;
    const licenseIds = [...new Set(images.filter((image) => !image.installed).map((image) => image.licenseId))];
    const licenses: AndroidSdkLicense[] = licenseIds.map((id) => ({
      id,
      title: id === "android-sdk-arm-dbt-license" ? "Android SDK Arm license" : "Android SDK License",
      text: LICENSE_TEXT,
      accepted: accepted.has(id),
      partIds: ["system-image"],
    }));
    const ordered = [...images].sort((a, b) => Number(b.installed) - Number(a.installed) || b.apiLevel - a.apiLevel);
    return {
      sdkRoot: ROOT,
      hostAbi: "arm64-v8a",
      images: ordered.map(entry),
      licenses,
      diskBytesFree: 412e9,
      emulatorVersion: "36.1.9",
      repositoryError: null,
      install,
      installingId: job.state === "running" ? installingId : null,
      checkedAt: new Date().toISOString(),
    };
  };

  return {
    api: {
      listSystemImages: async () => delay(await inventory(), 420),
      installSystemImage: async (args) => {
        const setupJob = await deps.setup.getSdkInstallState({});
        if (job.state === "running" || setupJob.state === "running") {
          throw new Error("ANDROID_SDK_INSTALL_BUSY: An Android SDK install already runs on this machine.");
        }
        const image = images.find((candidate) => candidate.id === args.id);
        if (!image) throw new Error(`ANDROID_NO_SYSTEM_IMAGE: Google publishes no system image ${args.id} for this machine.`);
        if (!args.acceptedLicenseIds.includes(image.licenseId)) {
          throw new Error("ANDROID_SDK_LICENSE_NOT_ACCEPTED: Accept the licence before the install.");
        }
        accepted.add(image.licenseId);
        installingId = image.id;
        const jobId = `mock-image-${Date.now()}`;
        const startedAt = new Date().toISOString();
        let done = 0;
        const tick = () => {
          if (job.state === "running" && job.cancelling) {
            if (timer !== null) window.clearInterval(timer);
            set({ state: "cancelled", jobId, sdkRoot: ROOT, finishedAt: new Date().toISOString(), installed: [] });
            return;
          }
          done = Math.min(image.downloadBytes, done + image.downloadBytes / 16);
          if (failInstall && done > image.downloadBytes / 2) {
            if (timer !== null) window.clearInterval(timer);
            set({
              state: "failed", jobId, sdkRoot: ROOT, finishedAt: new Date().toISOString(), partId: "system-image",
              error: { code: "ANDROID_SDK_INSTALL_FAILED", message: "The image download stopped after 4 attempts (ECONNRESET)." },
              installed: [],
            });
            return;
          }
          if (done >= image.downloadBytes) {
            if (timer !== null) window.clearInterval(timer);
            image.installed = true;
            set({ state: "done", jobId, sdkRoot: ROOT, finishedAt: new Date().toISOString(), installed: ["system-image"] });
            deps.emit({ type: "android.inventory.changed" });
            return;
          }
          set({
            state: "running", jobId, sdkRoot: ROOT, startedAt, step: "download", partId: "system-image", partLabel: imageName(image),
            partIndex: 0, partCount: 1, bytesDone: done, bytesTotal: image.downloadBytes, overallDone: done, overallTotal: image.downloadBytes,
            etaSeconds: Math.max(1, Math.round(((image.downloadBytes - done) / image.downloadBytes) * 4)), cancelling: false,
          });
        };
        tick();
        timer = window.setInterval(tick, 250);
        return job;
      },
      removeSystemImage: async (args) => {
        const image = images.find((candidate) => candidate.id === args.id && candidate.installed);
        if (!image) throw new Error(`ANDROID_NO_SYSTEM_IMAGE: ${args.id} is not installed on this machine.`);
        const users = avdsFor(image);
        if (users.some((avd) => avd.running)) {
          throw new Error(`ANDROID_SYSTEM_IMAGE_IN_USE: ${users.filter((avd) => avd.running).map((avd) => avd.name).join(", ")} runs on ${imageName(image)}. Stop it first.`);
        }
        if (users.length && !args.confirmedInUse) {
          throw new Error(`ANDROID_SYSTEM_IMAGE_IN_USE: ${users.map((avd) => avd.name).join(", ")} use ${imageName(image)}. Confirm to remove it anyway.`);
        }
        image.installed = false;
        deps.emit({ type: "android.inventory.changed" });
        return delay({ id: image.id, removed: true, freedBytes: image.sizeBytes, avdsLeft: users.map((avd) => avd.name) }, 300);
      },
      runInstrumentationTests: async (args): Promise<AndroidInstrumentationTestResult> => {
        const failing = failingTests;
        const filter = args.className ? `${args.className}${args.method ? `#${args.method}` : ""}` : null;
        return delay({
          laneId: args.laneId,
          gradleTask: ":app:connectedDebugAndroidTest",
          filter,
          ok: !failing,
          exitCode: failing ? 1 : 0,
          source: "junit-xml",
          total: 12,
          passed: failing ? 9 : 11,
          failed: failing ? 2 : 0,
          skipped: 1,
          failures: failing
            ? [
              { className: "com.example.sample.LoginTest", name: "signInShowsGreeting", message: ["java.lang.AssertionError: expected:<Hello, Ada> but was:<Sign in>", "at com.example.sample.LoginTest.signInShowsGreeting(LoginTest.kt:42)"] },
              { className: "com.example.sample.CartTest", name: "emptyCartHidesCheckout", message: ["androidx.test.espresso.NoMatchingViewException: No views in hierarchy found matching: with id: checkout"] },
            ]
            : [],
          resultFiles: [`/Users/mock/lane/app/build/outputs/androidTest-results/connected/debug/TEST-Medium_Phone(AVD) - 16-_app-.xml`],
          reportPath: "/Users/mock/lane/app/build/reports/androidTests/connected/debug/index.html",
          durationMs: 48_000,
          outputTail: [],
        }, 2_400);
      },
      // The machine has one SDK install job: an image install answers here too.
      getSdkInstallState: async (args) => (job.state === "running" ? delay(job, 60) : deps.setup.getSdkInstallState(args)),
      cancelSdkInstall: async (args) => {
        if (job.state !== "running") return deps.setup.cancelSdkInstall(args);
        set({ ...job, cancelling: true });
        return delay(job, 60);
      },
    },
    installed: () => images
      .filter((image) => image.installed)
      .map((image) => ({
        packageId: image.id,
        apiLevel: image.apiLevel,
        tag: image.tag,
        abi: "arm64-v8a",
        path: `${ROOT}/${image.id.split(";").join("/")}`,
      })),
  };
}
