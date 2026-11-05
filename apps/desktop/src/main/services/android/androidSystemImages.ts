import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  AndroidAvdListing,
  AndroidEmulatorEvent,
  AndroidSdkInstallState,
  AndroidSdkLicense,
  AndroidSdkSetupPart,
  AndroidSdkStatus,
  AndroidSystemImage,
  AndroidSystemImageAvd,
  AndroidSystemImageEntry,
  AndroidSystemImageInstallArgs,
  AndroidSystemImageInventory,
  AndroidSystemImageListArgs,
  AndroidSystemImageOffer,
  AndroidSystemImageRemoveArgs,
  AndroidSystemImageRemoveResult,
} from "../../../shared/types/androidEmulator";
import type { Logger } from "../logging/logger";
import { getErrorMessage } from "../shared/utils";
import { measureAndroidAvdBytes, pickAndroidSystemImage } from "./androidAvds";
import { AndroidEmulatorFailure } from "./androidEmulatorErrors";
import { listAndroidSystemImages, readAndroidIniFile } from "./androidSdk";
import {
  androidFreeBytesAt,
  androidSdkFolderWritable,
  androidSdkInstaller,
  androidSdkLicenseAccepted,
  androidSdkLicenseTitle,
  androidSystemImageInstalledBytes,
  type AndroidPlannedSdkPart,
  type AndroidSdkInstallDeps,
} from "./androidSdkInstall";
import {
  androidLicenseText,
  androidRepoHost,
  compareRevisions,
  fetchAndroidSetupManifests,
  pickAndroidArchive,
  type AndroidRepoArchive,
  type AndroidRepoFetch,
  type AndroidRepoHost,
  type AndroidRepoManifest,
  type AndroidRepoPackage,
} from "./androidSdkRepository";

/*
 * The system image manager (plan §6 P3, "like Runtimes"): the images on this
 * machine, the phone images Google publishes for the host ABI, install and
 * remove.
 *
 * - The list reads the SDK's `system-images/` folder, each AVD's
 *   `config.ini` (`image.sysdir.1`) for the AVDs that boot from an image, and
 *   Google's `sys-img2-3.xml` manifests (the ones the guided install reads).
 * - An install is one part on the guided install's job
 *   (`androidSdkInstaller`): one install per machine, the licence files and
 *   the consent record, the SHA-1 check, progress events and cancel.
 * - A removal deletes only the image folder. It refuses while an AVD that
 *   uses the image runs, and it needs the person's confirmation when AVDs use
 *   it. ADE never touches an AVD's own files.
 *
 * Node built-ins and relative imports only, so it runs under `tsx`.
 */

const IMAGE_ID = /^system-images;[A-Za-z0-9._-]+;[A-Za-z0-9._-]+;[A-Za-z0-9._-]+$/u;
/** The platforms the list offers: API levels (`android-36`, `android-36.1`), no previews, extensions or canaries. */
const OFFERED_PLATFORM = /^android-\d+(\.\d+)?$/u;
/** The phone image tags the list offers, best first. */
const OFFERED_TAGS = ["google_apis_playstore", "google_apis"] as const;
/** Where the consent record says the person accepted the licence. */
const CONSENT_SURFACE = "ADE device picker › System images";
/** The work folder the installer also uses; a removal moves the image here before it deletes it. */
const STAGING_DIR = ".ade-staging";
/** Image installs remembered by job id, for `installingId`. */
const JOB_MEMORY = 8;

/**
 * The image each install job is for. Process-wide, as the installer job is,
 * so every project's service names the same image.
 */
const jobImageIds = new Map<string, string>();

export type AndroidSystemImagesDeps = {
  readSdk: () => Promise<AndroidSdkStatus>;
  /** The AVDs on this machine, with their lane and running state (the device list). */
  listAvds: () => Promise<AndroidAvdListing[]>;
  emit: (event: AndroidEmulatorEvent) => void;
  logger: Logger | null;
  platform: NodeJS.Platform;
  env: Readonly<Record<string, string | undefined>>;
  home: string;
  machine?: string;
  /** Production uses `fetch`. */
  fetchImpl?: typeof fetch;
  /** An install finished and put the image in place. */
  onInstalled?: () => void;
};

/** `system-images;android-36;…`, also from `system-images/android-36/…` or without the prefix. */
function normalizeAndroidSystemImageId(value: unknown): string {
  const raw = typeof value === "string" ? value.trim().replace(/[\\/]+/gu, ";").replace(/;+$/u, "") : "";
  const id = raw.startsWith("system-images;") ? raw : `system-images;${raw}`;
  // A `.` or `..` segment is never a package name; refuse it before any path is built.
  if (!raw || !IMAGE_ID.test(id) || id.split(";").some((segment) => segment === "." || segment === "..")) {
    throw new Error(
      `id must be a system image package such as system-images;android-36;google_apis_playstore;arm64-v8a${raw ? ` (got ${JSON.stringify(raw)})` : ""}.`,
    );
  }
  return id;
}

const sameId = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

function parseRevision(text: string | null | undefined): number[] | null {
  if (!text) return null;
  const parts = text.trim().split(/[.\s-]/u).map(Number);
  return parts.length > 0 && parts.every(Number.isFinite) ? parts : null;
}

function tagLabel(tag: string): string {
  if (tag === "google_apis_playstore") return "Google Play";
  if (tag === "google_apis") return "Google APIs";
  if (tag === "google_apis_playstore_ps16k") return "Google Play · 16 KB pages";
  if (tag === "google_apis_ps16k") return "Google APIs · 16 KB pages";
  if (tag === "default") return "AOSP";
  return tag;
}

/** "API 36.1 · Google Play · arm64". */
function imageName(platform: string, tag: string, abi: string): string {
  const version = platform.replace(/^android-/u, "");
  return [`API ${version}`, tagLabel(tag), abi === "arm64-v8a" ? "arm64" : abi].join(" · ");
}

function idParts(id: string): { platform: string; tag: string; abi: string } {
  const [, platform = "", tag = "", abi = ""] = id.split(";");
  return { platform, tag, abi };
}

function tagRank(tag: string): number {
  const index = (OFFERED_TAGS as readonly string[]).indexOf(tag);
  return index < 0 ? OFFERED_TAGS.length : index;
}

/**
 * The image an AVD boots: `image.sysdir.1` from its `config.ini`
 * (`system-images/android-36/google_apis_playstore/arm64-v8a/`). An AVD with
 * no such line matches an installed image by API level, tag and ABI.
 */
function avdImageId(avd: AndroidAvdListing, installed: readonly AndroidSystemImage[]): string | null {
  const sysdir = readAndroidIniFile(path.join(avd.path, "config.ini"))?.get("image.sysdir.1");
  if (sysdir) {
    const parts = sysdir.split(/[\\/]+/u).filter(Boolean);
    if (parts[0] === "system-images" && parts.length >= 4) return parts.slice(0, 4).join(";");
  }
  const match = installed.find((image) =>
    idParts(image.packageId).platform === `android-${avd.apiLevel}` && image.tag === avd.tag && image.abi === avd.abi);
  return match?.packageId ?? null;
}

function avdSummary(avd: AndroidAvdListing): AndroidSystemImageAvd {
  return {
    name: avd.name,
    displayName: avd.displayName,
    adeCreated: avd.adeCreated,
    heldByLaneId: avd.heldByLaneId,
    running: avd.running !== null,
  };
}

type Offer = { pkg: AndroidRepoPackage; archive: AndroidRepoArchive; manifest: AndroidRepoManifest };

/** The newest stable package of each image path that has an archive for this host. */
function newestOffers(manifests: readonly AndroidRepoManifest[], host: AndroidRepoHost): Map<string, Offer> {
  const offers = new Map<string, Offer>();
  for (const manifest of manifests) {
    for (const pkg of manifest.packages) {
      if (pkg.channel !== "stable" || pkg.obsolete || !IMAGE_ID.test(pkg.path)) continue;
      const archive = pickAndroidArchive(pkg, host);
      if (!archive) continue;
      const key = pkg.path.toLowerCase();
      const held = offers.get(key);
      if (!held || compareRevisions(pkg.revisionParts, held.pkg.revisionParts) > 0) offers.set(key, { pkg, archive, manifest });
    }
  }
  return offers;
}

function offerOf(offer: Offer): AndroidSystemImageOffer {
  const needs = offer.pkg.dependencies.find((dependency) => dependency.path === "emulator")?.minRevision ?? null;
  return {
    revision: offer.pkg.revision,
    downloadBytes: offer.archive.size,
    installedBytes: androidSystemImageInstalledBytes(offer.archive.size),
    licenseId: offer.pkg.licenseId,
    needsEmulator: needs ? needs.join(".") : null,
  };
}

function emulatorTooOld(offer: AndroidSystemImageOffer | null, emulatorVersion: string | null): boolean {
  const needs = parseRevision(offer?.needsEmulator);
  const have = parseRevision(emulatorVersion);
  return Boolean(needs && have && compareRevisions(have, needs) < 0);
}

export function createAndroidSystemImages(deps: AndroidSystemImagesDeps) {
  const installer = androidSdkInstaller();
  const { logger, platform } = deps;
  const machine = deps.machine ?? (typeof os.machine === "function" ? os.machine() : process.arch);
  const installDeps: AndroidSdkInstallDeps = {
    platform,
    machine,
    env: deps.env,
    home: deps.home,
    fetchImpl: deps.fetchImpl,
    logger,
  };

  const installingId = (state: AndroidSdkInstallState): string | null =>
    ("jobId" in state ? jobImageIds.get(state.jobId) : undefined) ?? null;

  const readManifests = async (): Promise<{ manifests: AndroidRepoManifest[]; host: AndroidRepoHost | null; error: string | null }> => {
    const host = androidRepoHost(platform, machine);
    if (!host) return { manifests: [], host: null, error: "Google publishes no Android emulator images for this computer." };
    try {
      const { images } = await fetchAndroidSetupManifests({ fetchImpl: deps.fetchImpl as AndroidRepoFetch | undefined });
      return { manifests: images, host, error: null };
    } catch (error) {
      logger?.warn("android.system_images.repository_failed", { error: getErrorMessage(error) });
      return { manifests: [], host, error: `Google's SDK repository could not be read: ${getErrorMessage(error)}` };
    }
  };

  /** The AVDs on this machine; a failed read lists none (the images still show). */
  const readAvds = async (): Promise<AndroidAvdListing[]> => {
    try {
      return await deps.listAvds();
    } catch (error) {
      logger?.warn("android.system_images.avds_failed", { error: getErrorMessage(error) });
      return [];
    }
  };

  const avdsUsing = (id: string, avds: readonly AndroidAvdListing[], installed: readonly AndroidSystemImage[]): AndroidAvdListing[] =>
    avds.filter((avd) => {
      const used = avdImageId(avd, installed);
      return used !== null && sameId(used, id);
    });

  const requireSdkRoot = async (): Promise<{ sdk: AndroidSdkStatus; root: string }> => {
    const sdk = await deps.readSdk();
    if (!sdk.found || !sdk.root) {
      throw new AndroidEmulatorFailure("ANDROID_SDK_NOT_FOUND", "No Android SDK is set up on this machine. Set it up first: the setup card in the Android tool.");
    }
    return { sdk, root: sdk.root };
  };

  const refuseWhileInstalling = (what: string) => {
    if (installer.isRunning()) {
      throw new AndroidEmulatorFailure("ANDROID_SDK_INSTALL_BUSY", `An Android SDK install already runs on this machine. Wait for it to end, then ${what}.`);
    }
  };

  /** After an install or a removal: every window reads its devices and the SDK again. */
  const announceChange = () => {
    deps.emit({ type: "android.inventory.changed" });
    void deps.readSdk().catch((error: unknown) => {
      logger?.warn("android.system_images.status_failed", { error: getErrorMessage(error) });
    });
  };

  return {
    async listSystemImages(args?: AndroidSystemImageListArgs): Promise<AndroidSystemImageInventory> {
      const sdk = await deps.readSdk();
      const install = installer.state;
      const checkedAt = new Date().toISOString();
      if (!sdk.found || !sdk.root) {
        return {
          sdkRoot: null,
          hostAbi: sdk.hostAbi,
          images: [],
          licenses: [],
          diskBytesFree: null,
          emulatorVersion: null,
          repositoryError: null,
          install,
          installingId: installingId(install),
          checkedAt,
        };
      }
      const root = sdk.root;
      const installed = listAndroidSystemImages(root);
      const emulator = sdk.tools.find((tool) => tool.id === "emulator");
      const emulatorVersion = emulator?.available ? emulator.version : null;
      const [avds, repo] = await Promise.all([
        readAvds(),
        args?.includeAvailable === false ? Promise.resolve({ manifests: [], host: null, error: null }) : readManifests(),
      ]);
      const offers = repo.host ? newestOffers(repo.manifests, repo.host) : new Map<string, Offer>();
      const newest = pickAndroidSystemImage(installed, sdk.hostAbi, { tagId: null });
      const entries: AndroidSystemImageEntry[] = await Promise.all(installed.map(async (image) => {
        const parts = idParts(image.packageId);
        const offer = offers.get(image.packageId.toLowerCase()) ?? null;
        const available = offer ? offerOf(offer) : null;
        const installedRevision = readAndroidIniFile(path.join(image.path, "source.properties"))?.get("Pkg.Revision") ?? null;
        const have = parseRevision(installedRevision);
        return {
          id: image.packageId,
          apiLevel: image.apiLevel,
          platform: parts.platform,
          tag: parts.tag,
          abi: image.abi,
          name: imageName(parts.platform, parts.tag, image.abi),
          installed: true,
          path: image.path,
          installedRevision,
          sizeBytes: await measureAndroidAvdBytes(image.path),
          avds: avdsUsing(image.packageId, avds, installed).map(avdSummary),
          newest: newest?.packageId === image.packageId,
          hostAbi: image.abi === sdk.hostAbi,
          available,
          updateAvailable: Boolean(offer && have && compareRevisions(offer.pkg.revisionParts, have) > 0),
          emulatorTooOld: emulatorTooOld(available, emulatorVersion),
        };
      }));
      const installedIds = new Set(installed.map((image) => image.packageId.toLowerCase()));
      const toInstall: AndroidSystemImageEntry[] = [];
      for (const [key, offer] of offers) {
        const parts = idParts(offer.pkg.path);
        if (installedIds.has(key) || parts.abi !== sdk.hostAbi) continue;
        if (!OFFERED_PLATFORM.test(parts.platform) || !(OFFERED_TAGS as readonly string[]).includes(parts.tag)) continue;
        const available = offerOf(offer);
        toInstall.push({
          id: offer.pkg.path,
          apiLevel: offer.pkg.apiLevel ?? Number(/^android-(\d+)/u.exec(parts.platform)?.[1] ?? 0),
          platform: parts.platform,
          tag: parts.tag,
          abi: parts.abi,
          name: imageName(parts.platform, parts.tag, parts.abi),
          installed: false,
          path: null,
          installedRevision: null,
          sizeBytes: null,
          avds: [],
          newest: false,
          hostAbi: true,
          available,
          updateAvailable: false,
          emulatorTooOld: emulatorTooOld(available, emulatorVersion),
        });
      }
      toInstall.sort((a, b) => b.apiLevel - a.apiLevel || tagRank(a.tag) - tagRank(b.tag) || a.id.localeCompare(b.id));
      // Every licence an install or an update from this list would need, with its text.
      const licenseIds = new Set(
        [...toInstall, ...entries.filter((entry) => entry.updateAvailable)]
          .map((entry) => entry.available?.licenseId)
          .filter((id): id is string => Boolean(id)),
      );
      const licenses: AndroidSdkLicense[] = [];
      for (const id of licenseIds) {
        const text = androidLicenseText(repo.manifests, id);
        if (!text) continue;
        licenses.push({ id, title: androidSdkLicenseTitle(id), text, accepted: androidSdkLicenseAccepted(root, id, text), partIds: ["system-image"] });
      }
      return {
        sdkRoot: root,
        hostAbi: sdk.hostAbi,
        images: [...entries, ...toInstall],
        licenses,
        diskBytesFree: androidFreeBytesAt(root),
        emulatorVersion,
        repositoryError: repo.error,
        install,
        installingId: installingId(install),
        checkedAt,
      };
    },

    async installSystemImage(args: AndroidSystemImageInstallArgs): Promise<AndroidSdkInstallState> {
      const id = normalizeAndroidSystemImageId(args?.id);
      refuseWhileInstalling("install the image");
      const { sdk, root } = await requireSdkRoot();
      const repo = await readManifests();
      if (!repo.host || repo.error) throw new AndroidEmulatorFailure("ANDROID_SDK_INSTALL_FAILED", repo.error ?? "Google's SDK repository could not be read.");
      const offer = newestOffers(repo.manifests, repo.host).get(id.toLowerCase()) ?? null;
      if (!offer) {
        throw new AndroidEmulatorFailure(
          "ANDROID_NO_SYSTEM_IMAGE",
          `Google's repository has no ${id} for this computer. \`ade android sdk images --text\` lists the images it has.`,
        );
      }
      const { pkg, archive, manifest } = offer;
      const parts = idParts(pkg.path);
      const name = imageName(parts.platform, parts.tag, parts.abi);
      const installed = listAndroidSystemImages(root);
      const current = installed.find((image) => sameId(image.packageId, id)) ?? null;
      const installedRevision = current ? readAndroidIniFile(path.join(current.path, "source.properties"))?.get("Pkg.Revision") ?? null : null;
      const have = parseRevision(installedRevision);
      const upToDate = Boolean(have && compareRevisions(have, pkg.revisionParts) >= 0);
      if (!upToDate) {
        const emulator = sdk.tools.find((tool) => tool.id === "emulator");
        const available = offerOf(offer);
        if (emulator?.available && emulatorTooOld(available, emulator.version)) {
          throw new AndroidEmulatorFailure(
            "ANDROID_TOOL_MISSING",
            `${name} needs the Android Emulator ${available.needsEmulator} or newer, and this SDK has ${emulator.version}. Update the emulator first (Android Studio's SDK Manager, or sdkmanager "emulator"), then install the image.`,
          );
        }
        if (current) {
          // An update replaces the folder: no emulator may run from it meanwhile.
          const running = avdsUsing(id, await readAvds(), installed).filter((avd) => avd.running !== null);
          if (running.length > 0) {
            throw new AndroidEmulatorFailure(
              "ANDROID_SYSTEM_IMAGE_IN_USE",
              `${running.map((avd) => avd.name).join(", ")} runs on ${name} now. Stop it first: the update replaces the image folder.`,
            );
          }
        }
        const accepted = new Set((Array.isArray(args.acceptedLicenseIds) ? args.acceptedLicenseIds : []).filter((value): value is string => typeof value === "string"));
        // The licence must be accepted in THIS request, even when an earlier install recorded it.
        const licenseText = pkg.licenseId ? androidLicenseText(repo.manifests, pkg.licenseId) : null;
        if (pkg.licenseId && licenseText && !accepted.has(pkg.licenseId)) {
          throw new AndroidEmulatorFailure("ANDROID_SDK_LICENSE_NOT_ACCEPTED", `Accept the ${androidSdkLicenseTitle(pkg.licenseId)} before the install.`);
        }
        const writable = androidSdkFolderWritable(root);
        if (!writable.writable) throw new AndroidEmulatorFailure("ANDROID_SDK_PATH_INVALID", writable.detail ?? `ADE cannot write to ${root}.`);
        // The zip stays until its unpack ends, so the drive holds both for a moment.
        const needed = androidSystemImageInstalledBytes(archive.size) + archive.size;
        const free = androidFreeBytesAt(root);
        if (free !== null && free < needed) {
          const gb = (bytes: number) => (bytes / 1e9).toFixed(1);
          throw new AndroidEmulatorFailure(
            "ANDROID_SDK_NO_SPACE",
            `${name} needs about ${gb(needed)} GB, and ${gb(free)} GB is free on that drive. Free some space, then install again.`,
          );
        }
      }
      // The repository read awaits: another install can start meanwhile.
      refuseWhileInstalling("install the image");
      const part: AndroidSdkSetupPart = {
        id: "system-image",
        label: name,
        packagePath: pkg.path,
        version: pkg.revision,
        installedVersion: installedRevision,
        missing: !upToDate,
        optional: false,
        downloadBytes: archive.size,
        installedBytes: androidSystemImageInstalledBytes(archive.size),
        licenseId: pkg.licenseId,
        detail: name,
      };
      const planned: AndroidPlannedSdkPart = { part, pkg, archive, manifest };
      logger?.info("android.system_image_install.start", { id, revision: pkg.revision, downloadBytes: archive.size, update: current !== null });
      const state = installer.start({
        sdkRoot: root,
        planned: [planned],
        manifests: repo.manifests,
        acceptedLicenseIds: pkg.licenseId ? [pkg.licenseId] : [],
        acceptedIn: CONSENT_SURFACE,
        deps: installDeps,
        onFinished: (finished) => {
          logger?.info("android.system_image_install.end", { id, state: finished.state });
          if (finished.state === "done" && finished.installed.length > 0) deps.onInstalled?.();
          // A new image changes what the brand tiles make; every window reads it again.
          announceChange();
        },
      });
      if ("jobId" in state) {
        jobImageIds.set(state.jobId, id);
        while (jobImageIds.size > JOB_MEMORY) jobImageIds.delete(jobImageIds.keys().next().value!);
      }
      return state;
    },

    async removeSystemImage(args: AndroidSystemImageRemoveArgs): Promise<AndroidSystemImageRemoveResult> {
      const id = normalizeAndroidSystemImageId(args?.id);
      refuseWhileInstalling("remove the image");
      const { root } = await requireSdkRoot();
      const installed = listAndroidSystemImages(root);
      const image = installed.find((entry) => sameId(entry.packageId, id)) ?? null;
      if (!image) {
        throw new AndroidEmulatorFailure("ANDROID_NO_SYSTEM_IMAGE", `${id} is not installed on this machine. \`ade android sdk images --text\` lists the installed images.`);
      }
      const parts = idParts(image.packageId);
      const name = imageName(parts.platform, parts.tag, image.abi);
      // Only a folder inside the SDK's own system-images folder, after symlinks.
      const base = fs.realpathSync(path.join(root, "system-images"));
      const dir = fs.realpathSync(image.path);
      if (!dir.startsWith(`${base}${path.sep}`)) {
        throw new AndroidEmulatorFailure("ANDROID_SDK_PATH_INVALID", `${image.path} is not inside ${base}, so ADE does not remove it.`);
      }
      const users = avdsUsing(image.packageId, await readAvds(), installed);
      const running = users.filter((avd) => avd.running !== null);
      if (running.length > 0) {
        throw new AndroidEmulatorFailure(
          "ANDROID_SYSTEM_IMAGE_IN_USE",
          `${running.map((avd) => avd.name).join(", ")} runs on ${name} now. Stop it first, then remove the image.`,
        );
      }
      if (users.length > 0 && args.confirmedInUse !== true) {
        throw new AndroidEmulatorFailure(
          "ANDROID_SYSTEM_IMAGE_IN_USE",
          `${users.length} device${users.length === 1 ? " uses" : "s use"} ${name} (${users.map((avd) => avd.name).join(", ")}). `
            + "They cannot start without it. The person confirms the removal in the device picker; ADE leaves their files.",
        );
      }
      // Recheck after the awaits: an install may have started into this SDK.
      refuseWhileInstalling("remove the image");
      const freedBytes = await measureAndroidAvdBytes(dir);
      // Move the folder out of `system-images/` first, so a removal that stops
      // half-way never leaves a folder the SDK reads as an installed image.
      const staging = path.join(root, STAGING_DIR);
      const aside = path.join(staging, `remove-${parts.platform}-${parts.tag}-${parts.abi}-${Date.now()}`);
      try {
        fs.mkdirSync(staging, { recursive: true });
        fs.renameSync(dir, aside);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "EBUSY" || ((code === "EPERM" || code === "EACCES") && platform === "win32")) {
          throw new AndroidEmulatorFailure(
            "ANDROID_SYSTEM_IMAGE_IN_USE",
            `A program holds ${name} open (an emulator, or Android Studio). Close it, then remove the image again.`,
          );
        }
        if (code === "EPERM" || code === "EACCES") {
          throw new AndroidEmulatorFailure("ANDROID_SDK_PATH_INVALID", `This account may not change ${dir}. Check its permissions, then remove the image again.`);
        }
        throw error;
      }
      try {
        await fs.promises.rm(aside, { recursive: true, force: true, maxRetries: 3 });
      } catch (error) {
        // The image is already out of the SDK; only its disk space waits for the next try.
        logger?.warn("android.system_image_remove.cleanup_failed", { id, aside, error: getErrorMessage(error) });
      }
      // Empty parent folders go too, as sdkmanager leaves none.
      for (const folder of [path.dirname(dir), path.dirname(path.dirname(dir)), staging]) {
        try {
          if (fs.existsSync(folder) && fs.readdirSync(folder).length === 0) fs.rmdirSync(folder);
        } catch (error) {
          logger?.warn("android.system_image_remove.rmdir_failed", { folder, error: getErrorMessage(error) });
        }
      }
      logger?.info("android.system_image_removed", { id, freedBytes, avdsLeft: users.length });
      announceChange();
      return { id: image.packageId, removed: true, freedBytes, avdsLeft: users.map((avd) => avd.name) };
    },
  };
}
