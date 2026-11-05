/**
 * The Android emulator contract, P3: the system image manager (the Android
 * side of the Apple picker's Runtimes section). Re-exported from
 * `androidEmulator.ts`; import from there.
 */

import type { AndroidSdkInstallState, AndroidSdkLicense } from "./androidEmulator";

/* ──────────────────────────────────────────────────────────────────────────
   P3 SYSTEM IMAGES: what each AVD boots.

   The list shows the images installed on the machine (size on disk, the AVDs
   that use each) and the phone images Google publishes for this host ABI.
   An install uses the guided SDK install's job (one install per machine, the
   licence consent, the checksum, progress, cancel). A removal deletes only
   the image folder, never an AVD's files. Install and remove are the
   person's (`ANDROID_SDK_PERSON_ONLY_ACTIONS`); an agent may read the list.
   ────────────────────────────────────────────────────────────────────────── */

/** An AVD on this machine that boots from an image. */
export type AndroidSystemImageAvd = {
  name: string;
  displayName: string | null;
  adeCreated: boolean;
  /** The lane that holds it, if any. */
  heldByLaneId: string | null;
  /** An emulator runs it now. */
  running: boolean;
};

/** One image the repository offers for this host. */
export type AndroidSystemImageOffer = {
  revision: string;
  downloadBytes: number;
  /** Disk after unpack (an estimate). */
  installedBytes: number;
  licenseId: string | null;
  /** The oldest emulator that boots it, from the manifest (`36.5.11`). */
  needsEmulator: string | null;
};

export type AndroidSystemImageEntry = {
  /** The sdkmanager path: `system-images;android-36;google_apis_playstore;arm64-v8a`. */
  id: string;
  apiLevel: number;
  /** `android-36`, `android-36.1`. */
  platform: string;
  /** `google_apis_playstore`, `google_apis`, `default`, … */
  tag: string;
  abi: string;
  /** "API 36 · Google Play · arm64". */
  name: string;
  installed: boolean;
  /** The image folder, when installed. */
  path: string | null;
  installedRevision: string | null;
  /** Bytes on disk, when installed. */
  sizeBytes: number | null;
  /** The AVDs that boot from it. */
  avds: AndroidSystemImageAvd[];
  /** The image a new phone gets when the caller names none (the brand tiles' default). */
  newest: boolean;
  /** Runs at full speed on this host (its ABI is the host's). */
  hostAbi: boolean;
  /** What the repository offers for this id, or null (not published for this host, or the repository could not be read). */
  available: AndroidSystemImageOffer | null;
  /** The repository has a newer revision than the installed one. */
  updateAvailable: boolean;
  /** The installed emulator is older than the image needs, so it would not boot. */
  emulatorTooOld: boolean;
};

export type AndroidSystemImageInventory = {
  /** Null when no SDK is set up (the list is then empty). */
  sdkRoot: string | null;
  hostAbi: "x86_64" | "arm64-v8a";
  /** Installed images first (newest API first), then the ones to install. */
  images: AndroidSystemImageEntry[];
  /** The licence of each image to install, with its text, for the consent dialog. */
  licenses: AndroidSdkLicense[];
  diskBytesFree: number | null;
  /** The installed emulator's version, when there is one. */
  emulatorVersion: string | null;
  /** Set when Google's repository could not be read; the installed images are still listed. */
  repositoryError: string | null;
  /** The machine's one SDK install job (images and the guided install share it). */
  install: AndroidSdkInstallState;
  /** The image the running (or last) install job is for, when it is an image install. */
  installingId: string | null;
  checkedAt: string;
};

export type AndroidSystemImageListArgs = {
  laneId?: string | null;
  /** False skips Google's repository (installed images only). Default true. */
  includeAvailable?: boolean;
};

export type AndroidSystemImageInstallArgs = {
  laneId?: string | null;
  id: string;
  /** Every licence id the person read and accepted in this request. */
  acceptedLicenseIds: string[];
};

export type AndroidSystemImageRemoveArgs = {
  laneId?: string | null;
  id: string;
  /** The person confirmed the removal although AVDs use the image. */
  confirmedInUse?: boolean;
};

export type AndroidSystemImageRemoveResult = {
  id: string;
  removed: boolean;
  freedBytes: number | null;
  /** The AVDs that used it. ADE leaves their files; they cannot start until an image is installed again. */
  avdsLeft: string[];
};

export type AndroidEmulatorImagesServiceApi = {
  listSystemImages(args?: AndroidSystemImageListArgs): Promise<AndroidSystemImageInventory>;
  /** Starts the download and returns at once; progress comes as `android.sdk.install` events. */
  installSystemImage(args: AndroidSystemImageInstallArgs): Promise<AndroidSdkInstallState>;
  removeSystemImage(args: AndroidSystemImageRemoveArgs): Promise<AndroidSystemImageRemoveResult>;
};
