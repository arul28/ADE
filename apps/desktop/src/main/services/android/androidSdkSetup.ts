import path from "node:path";
import type {
  AndroidEmulatorEvent,
  AndroidEmulatorSetupServiceApi,
  AndroidEmulatorStatus,
  AndroidSdkConsentSurface,
  AndroidSdkInstallState,
  AndroidSdkStatus,
} from "../../../shared/types/androidEmulator";
import type { Logger } from "../logging/logger";
import { getErrorMessage } from "../shared/utils";
import { AndroidEmulatorFailure } from "./androidEmulatorErrors";
import { androidSdkInstaller, buildAndroidSdkSetupPlan, type AndroidSdkInstallDeps } from "./androidSdkInstall";
import { locateAndroidSdk, readAndroidSdkStatus } from "./androidSdk";
import type { AndroidSettingsFile } from "./androidMachinePreferences";

/*
 * The service side of the guided SDK install and of "Use mine…".
 *
 * The SDK choice is a machine setting (`<ADE home>/android/settings.json`),
 * not a project one: every project on the machine uses the same SDK, and a
 * Dock launch on macOS has no `ANDROID_HOME` to fall back on.
 */

/** Reads and writes the SDK folder in the machine's Android settings file; a missing or broken file reads as none. */
export function createAndroidSdkSettingStore(settings: AndroidSettingsFile) {
  return {
    read(): string | null {
      const sdkPath = settings.read().sdkPath;
      return typeof sdkPath === "string" && sdkPath.trim() ? sdkPath.trim() : null;
    },
    write(sdkPath: string | null): void {
      if (!settings.persistent) throw new AndroidEmulatorFailure("ANDROID_SDK_PATH_INVALID", "This ADE cannot save an SDK folder.");
      // Merged into the file: its other keys (the machine `preferences`) stay.
      settings.writeKeys({ sdkPath });
    },
  };
}

export type AndroidSdkSetupDeps = {
  readSdk: (options?: { forceAccelCheck?: boolean }) => Promise<AndroidSdkStatus>;
  getStatus: () => Promise<AndroidEmulatorStatus>;
  settings: ReturnType<typeof createAndroidSdkSettingStore>;
  emit: (event: AndroidEmulatorEvent) => void;
  logger: Logger | null;
  platform: NodeJS.Platform;
  env: Readonly<Record<string, string | undefined>>;
  home: string;
  /** Test seam for the repository and download; production uses `fetch`. */
  fetchImpl?: typeof fetch;
  /** An install finished and put at least one part in place. */
  onInstalled?: () => void;
};

/** The words the consent record keeps for where the user accepted the licences. */
function consentSurfaceLabel(surface: AndroidSdkConsentSurface | null | undefined): string {
  if (surface === "setup-card") return "ADE setup card";
  if (surface === "settings") return "Settings › Android devices";
  return "ADE desktop app";
}

export function createAndroidSdkSetup(deps: AndroidSdkSetupDeps): AndroidEmulatorSetupServiceApi & { dispose(): void } {
  const installer = androidSdkInstaller();
  const installDeps: AndroidSdkInstallDeps = {
    platform: deps.platform,
    env: deps.env,
    home: deps.home,
    fetchImpl: deps.fetchImpl,
    logger: deps.logger,
  };
  // Every service on the machine hears the shared job, so each window's card moves together.
  const unsubscribe = installer.subscribe((install) => deps.emit({ type: "android.sdk.install", install }));

  const planFor = async (args: { sdkRoot?: string | null; includeAndroidCli?: boolean } | undefined) => {
    let sdk = await deps.readSdk();
    const chosen = args?.sdkRoot?.trim() ? path.resolve(args.sdkRoot.trim()) : null;
    if (chosen && (!sdk.root || path.resolve(sdk.root) !== chosen)) {
      // A chosen folder that already holds an SDK keeps its parts: plan from what IT has.
      // Only that folder counts (no env, no default root); acceleration and the AVD folder stay the machine's.
      const there = await readAndroidSdkStatus({ settingPath: chosen, env: {}, platform: deps.platform, home: "/nonexistent-home" });
      sdk = there.found && there.root && path.resolve(there.root) === chosen
        ? { ...there, acceleration: sdk.acceleration, avdHome: sdk.avdHome }
        : { ...sdk, found: false, root: null, source: null, tools: [] };
    }
    return buildAndroidSdkSetupPlan(
      { sdk, chosenRoot: args?.sdkRoot ?? null, includeAndroidCli: args?.includeAndroidCli ?? false },
      installer.state,
      sdk.acceleration,
      installDeps,
    );
  };

  return {
    async getSdkSetupPlan(args) {
      return (await planFor(args)).plan;
    },

    async installSdk(args) {
      if (installer.isRunning()) {
        throw new AndroidEmulatorFailure("ANDROID_SDK_INSTALL_BUSY", "An Android SDK install already runs on this machine.");
      }
      const { plan, planned, manifests } = await planFor(args);
      // The plan reads the network and the disk: another install can start while it does.
      if (installer.isRunning()) {
        throw new AndroidEmulatorFailure("ANDROID_SDK_INSTALL_BUSY", "An Android SDK install already runs on this machine.");
      }
      if (!plan.hostSupported) throw new AndroidEmulatorFailure("ANDROID_SDK_INSTALL_FAILED", plan.unsupportedReason ?? "This computer cannot run the Android emulator.");
      if (plan.repositoryError) throw new AndroidEmulatorFailure("ANDROID_SDK_INSTALL_FAILED", plan.repositoryError);
      if (!plan.writable) throw new AndroidEmulatorFailure("ANDROID_SDK_PATH_INVALID", plan.writableDetail ?? `ADE cannot write to ${plan.sdkRoot}.`);
      const accepted = new Set((Array.isArray(args?.acceptedLicenseIds) ? args.acceptedLicenseIds : []).filter((id): id is string => typeof id === "string"));
      // Every licence a missing part uses must be accepted in THIS request, even one an earlier install recorded:
      // the person installing now is the one agreeing.
      const missingConsent = plan.licenses.filter((license) => !accepted.has(license.id));
      if (missingConsent.length > 0) {
        throw new AndroidEmulatorFailure(
          "ANDROID_SDK_LICENSE_NOT_ACCEPTED",
          `Accept ${missingConsent.map((license) => license.title).join(" and ")} before the install.`,
        );
      }
      if (plan.diskBytesFree !== null && plan.diskBytesFree < plan.diskBytesNeeded) {
        const gb = (bytes: number) => (bytes / 1e9).toFixed(1);
        throw new AndroidEmulatorFailure(
          "ANDROID_SDK_NO_SPACE",
          `The install needs about ${gb(plan.diskBytesNeeded)} GB, and ${gb(plan.diskBytesFree)} GB is free on that drive. Free some space or pick another folder.`,
        );
      }
      // A folder ADE would not find by itself becomes the machine's SDK setting once the install starts,
      // so a partial install is visible too.
      const located = locateAndroidSdk({ settingPath: deps.settings.read(), env: deps.env, platform: deps.platform, home: deps.home });
      const sameAsFound = located && path.resolve(located.root) === path.resolve(plan.sdkRoot);
      const previousSetting = deps.settings.read();
      const wantSetting = plan.sdkRootSource === "chosen" && !sameAsFound;
      let wroteSetting = false;
      let started = false;
      let finishedEarly: AndroidSdkInstallState | null = null;
      const installedNothing = (state: AndroidSdkInstallState) => state.state !== "done" && "installed" in state && state.installed.length === 0;
      deps.logger?.info("android.sdk_install.start", {
        sdkRoot: plan.sdkRoot,
        parts: plan.parts.filter((part) => part.missing).map((part) => part.id),
        licenses: plan.licenses.map((license) => license.id),
        downloadBytes: plan.downloadBytes,
      });
      const state = installer.start({
        sdkRoot: plan.sdkRoot,
        planned,
        manifests,
        acceptedLicenseIds: [...accepted],
        acceptedIn: consentSurfaceLabel(args?.surface),
        deps: installDeps,
        onFinished: (state: AndroidSdkInstallState) => {
          if (!started) finishedEarly = state;
          deps.logger?.info("android.sdk_install.end", { state: state.state });
          if (state.state === "done" && state.installed.length > 0) deps.onInstalled?.();
          // An install that put nothing in place leaves the machine's SDK choice as it was.
          if (wroteSetting && installedNothing(state) && deps.settings.read() === plan.sdkRoot) deps.settings.write(previousSetting);
          // A fresh SDK changes the status every window shows (the card becomes the picker).
          deps.emit({ type: "android.sdk.changed" });
          void deps.readSdk({ forceAccelCheck: true }).catch((error: unknown) => {
            deps.logger?.warn("android.sdk_install.status_failed", { error: getErrorMessage(error) });
          });
        },
      });
      started = true;
      const early: AndroidSdkInstallState | null = finishedEarly;
      if (wantSetting && !(early && installedNothing(early))) {
        deps.settings.write(plan.sdkRoot);
        wroteSetting = true;
        if (early) deps.emit({ type: "android.sdk.changed" });
      }
      return state;
    },

    async cancelSdkInstall() {
      return installer.cancel();
    },

    async getSdkInstallState() {
      return installer.state;
    },

    async setSdkPath(args) {
      const raw = args && typeof args.path === "string" ? args.path.trim() : null;
      if (!raw) {
        deps.settings.write(null);
        deps.emit({ type: "android.sdk.changed" });
        return deps.getStatus();
      }
      if (!path.isAbsolute(raw)) throw new AndroidEmulatorFailure("ANDROID_SDK_PATH_INVALID", "Give the full path of the SDK folder.");
      const located = locateAndroidSdk({ settingPath: raw, env: {}, platform: deps.platform, home: "/nonexistent-home" });
      if (!located || located.source !== "setting") {
        throw new AndroidEmulatorFailure(
          "ANDROID_SDK_PATH_INVALID",
          `${raw} is not an Android SDK. Pick the folder that holds platform-tools, emulator or system-images.`,
        );
      }
      deps.settings.write(located.root);
      deps.logger?.info("android.sdk_path.set", { sdkRoot: located.root });
      deps.emit({ type: "android.sdk.changed" });
      return deps.getStatus();
    },

    dispose() {
      unsubscribe();
    },
  };
}
