/**
 * The Android emulator contract, P1 setup: the guided SDK install.
 * Re-exported from `androidEmulator.ts`; import from there.
 */

import type { OpenProjectBinding } from "./core";
import type { AndroidAcceleration, AndroidEmulatorStatus, AndroidErrorCode } from "./androidEmulator";

type Pin = OpenProjectBinding | null | undefined;

/* ──────────────────────────────────────────────────────────────────────────
   P1 SETUP (coordinator): the guided SDK install.

   The setup card reads a plan (what is missing, the sizes, the licences, the
   free disk), the user reads and accepts each licence, and the brain installs
   the parts from Google's repository with no Java. ADE never accepts a licence
   by itself: `installSdk` names every licence id the user accepted, and the
   brain refuses when one is missing. An agent may read the plan, never install.
   ────────────────────────────────────────────────────────────────────────── */

export type AndroidSdkSetupPartId = "platform-tools" | "emulator" | "cmdline-tools" | "system-image" | "android-cli";

export type AndroidSdkSetupPart = {
  id: AndroidSdkSetupPartId;
  /** "Platform tools", "Emulator", "Phone image", … */
  label: string;
  /** The sdkmanager package path, or null for the Android CLI. */
  packagePath: string | null;
  /** The version the install would put in place. */
  version: string | null;
  /** The version already installed, when there is one. */
  installedVersion: string | null;
  /** True when the install would add this part. */
  missing: boolean;
  /** The Android CLI; never needed for a boot. */
  optional: boolean;
  downloadBytes: number;
  /** Disk after unpack (an estimate for the plan). */
  installedBytes: number;
  licenseId: string | null;
  /** One short detail line (`API 36 · Google Play · arm64`). */
  detail: string | null;
};

export type AndroidSdkLicense = {
  id: string;
  /** A readable name ("Android SDK License"). */
  title: string;
  text: string;
  /** The SDK's `licenses/<id>` already holds an acceptance. */
  accepted: boolean;
  /** The parts that need it. */
  partIds: AndroidSdkSetupPartId[];
};

export type AndroidSdkInstallStep = "download" | "verify" | "unpack" | "finish";

export type AndroidSdkInstallState =
  | { state: "idle" }
  | {
    state: "running";
    jobId: string;
    sdkRoot: string;
    startedAt: string;
    step: AndroidSdkInstallStep;
    partId: AndroidSdkSetupPartId;
    partLabel: string;
    partIndex: number;
    partCount: number;
    /** Bytes of this step. */
    bytesDone: number;
    bytesTotal: number;
    /** Download bytes over every part, for the one bar. */
    overallDone: number;
    overallTotal: number;
    etaSeconds: number | null;
    cancelling: boolean;
  }
  | { state: "done"; jobId: string; sdkRoot: string; finishedAt: string; installed: AndroidSdkSetupPartId[] }
  | {
    state: "failed";
    jobId: string;
    sdkRoot: string;
    finishedAt: string;
    partId: AndroidSdkSetupPartId | null;
    error: { code: AndroidErrorCode; message: string };
    installed: AndroidSdkSetupPartId[];
  }
  | { state: "cancelled"; jobId: string; sdkRoot: string; finishedAt: string; installed: AndroidSdkSetupPartId[] };

export type AndroidSdkSetupPlan = {
  /** False when Google publishes no emulator for this host (Windows on Arm, other OSes). */
  hostSupported: boolean;
  unsupportedReason: string | null;
  /** Where the install goes: the found SDK, the folder the user chose, or the platform default. */
  sdkRoot: string;
  sdkRootSource: "found" | "chosen" | "default";
  /** The SDK already in the install folder, when there is one. */
  existingSdkRoot: string | null;
  parts: AndroidSdkSetupPart[];
  licenses: AndroidSdkLicense[];
  /** Download and disk totals for the parts that are missing (and the CLI, when asked). */
  downloadBytes: number;
  diskBytesNeeded: number;
  diskBytesFree: number | null;
  /** The install folder can be made and written. */
  writable: boolean;
  writableDetail: string | null;
  /** Where new devices go, and its free space (each device takes several GB). */
  avdHome: string | null;
  avdHomeFreeBytes: number | null;
  acceleration: AndroidAcceleration;
  /** Set when Google's repository could not be read; the parts then carry no versions or sizes. */
  repositoryError: string | null;
  install: AndroidSdkInstallState;
  checkedAt: string;
};

export type AndroidSdkSetupArgs = {
  /** The install folder the user picked with the pencil; omitted = the plan's own choice. */
  sdkRoot?: string | null;
  /** Add the optional Android CLI. */
  includeAndroidCli?: boolean;
};

/** Where in the desktop app the person accepted the licences, for the SDK's consent record. */
export const ANDROID_SDK_CONSENT_SURFACES = ["setup-card", "settings"] as const;
export type AndroidSdkConsentSurface = (typeof ANDROID_SDK_CONSENT_SURFACES)[number];

export type AndroidSdkInstallArgs = AndroidSdkSetupArgs & {
  /** Every licence id the user read and accepted in this request. */
  acceptedLicenseIds: string[];
  /** The card the person used. Omitted = the desktop app, place not named. */
  surface?: AndroidSdkConsentSurface | null;
};

export type AndroidSetSdkPathArgs = {
  /** An existing SDK folder ("Use mine…"), or null to go back to detection. */
  path: string | null;
};

export type AndroidEmulatorSetupServiceApi = {
  getSdkSetupPlan(args?: AndroidSdkSetupArgs): Promise<AndroidSdkSetupPlan>;
  /** Starts the install and returns at once; progress comes as `android.sdk.install` events. */
  installSdk(args: AndroidSdkInstallArgs): Promise<AndroidSdkInstallState>;
  cancelSdkInstall(): Promise<AndroidSdkInstallState>;
  getSdkInstallState(): Promise<AndroidSdkInstallState>;
  setSdkPath(args: AndroidSetSdkPathArgs): Promise<AndroidEmulatorStatus>;
};

export type AndroidEmulatorSetupPreloadApi = {
  getSdkSetupPlan(args?: AndroidSdkSetupArgs, pin?: Pin): Promise<AndroidSdkSetupPlan>;
  installSdk(args: AndroidSdkInstallArgs, pin?: Pin): Promise<AndroidSdkInstallState>;
  cancelSdkInstall(args?: Record<string, never>, pin?: Pin): Promise<AndroidSdkInstallState>;
  getSdkInstallState(args?: Record<string, never>, pin?: Pin): Promise<AndroidSdkInstallState>;
  setSdkPath(args: AndroidSetSdkPathArgs, pin?: Pin): Promise<AndroidEmulatorStatus>;
};
