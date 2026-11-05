import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import type {
  AndroidAcceleration,
  AndroidSdkInstallState,
  AndroidSdkLicense,
  AndroidSdkSetupPart,
  AndroidSdkSetupPartId,
  AndroidSdkSetupPlan,
  AndroidSdkStatus,
} from "../../../shared/types/androidEmulator";
import { androidCliArgs, androidCliDownloadUrl, androidCliInstallPath, locateAndroidCli, readAndroidCliVersion } from "./androidCli";
import { AndroidEmulatorFailure } from "./androidEmulatorErrors";
import {
  androidLicenseText,
  androidRepoHost,
  compareRevisions,
  fetchAndroidSetupManifests,
  newestStablePackage,
  pickAndroidArchive,
  pickAndroidSetupImage,
  type AndroidRepoArchive,
  type AndroidRepoFetch,
  type AndroidRepoManifest,
  type AndroidRepoPackage,
} from "./androidSdkRepository";
import { extractZip, readZipEntries, zipCommonRoot } from "./androidZipExtract";

/*
 * The guided SDK install (plan §3.4 and §5 "SDK missing").
 *
 * The minimum set is platform-tools, the emulator, the command-line tools
 * (ADE reads the hardware profiles from them) and one phone image for the
 * host ABI, about 2.5 GB of downloads. Each part comes from Google's
 * repository, is checked against the manifest's SHA-1, unpacked with ADE's
 * own zip reader and moved into place, so the SDK looks the same as one
 * `sdkmanager` made (`source.properties` from the archive, `package.xml`,
 * `licenses/<id>`).
 *
 * One install runs per machine: a process-wide job (every project's service
 * shares it) and a lock file in the SDK folder (a second ADE process on the
 * same machine). A cancel leaves the finished parts in place and keeps the
 * partial download, so the next install resumes it.
 */

const DOWNLOADS_DIR = ".ade-downloads";
const STAGING_DIR = ".ade-staging";
const LOCK_FILE = ".ade-install.lock";
const CONSENT_FILE = path.join(".ade", "license-consents.json");
/** A lock older than this whose process is gone is stale. */
const LOCK_STALE_MS = 6 * 60 * 60_000;
const DOWNLOAD_ATTEMPTS = 4;
const PROGRESS_INTERVAL_MS = 250;

/**
 * Disk after unpack, as a multiple of the download. Measured on macOS arm64
 * (2026-11-05): the zips compress the system image and the emulator about
 * 2–3 times. The plan adds the largest zip (kept until its unpack ends).
 */
const UNPACK_FACTOR: Record<AndroidSdkSetupPartId, number> = {
  "platform-tools": 2.6,
  emulator: 2.4,
  "cmdline-tools": 1.2,
  "system-image": 2.6,
  "android-cli": 45,
};

/**
 * The acceptance hash Google's own tools write for a licence id. The
 * Android CLI writes `24333f8a…` for `android-sdk-license` (checked
 * 2026-11-05 with `android sdk install platform-tools`), the value
 * `sdkmanager` writes after a person accepts. The others are the values
 * `sdkmanager --licenses` writes. ADE also writes the SHA-1 of the text it
 * showed, so the file records exactly what the person read.
 */
const KNOWN_LICENSE_HASHES: Record<string, string> = {
  "android-sdk-license": "24333f8a63b6825ea9c5514f83c2829b004d1fee",
  "android-sdk-preview-license": "504667f4c0de7af1a06de9f4b1727b84351f2910",
  "android-sdk-arm-dbt-license": "859f317696f67ef3d7f30a50a5560e7834b43903",
  "android-googletv-license": "601085b94cd77f0b54ff86406957099ebe79c4d6",
  "intel-android-extra-license": "d975f751698a77b662f1254ddbeed3901e976f5a",
  "mips-android-sysimage-license": "e9acab5b5fbb560a72cfaecce8946896ff6aab9d",
  "google-gdk-license": "33b6a2b64607f11b759f320ef9dff4ae5c47d97a",
};

/** The Android CLI shows the SDK terms on its first run; ADE asks for them before the download. */
const ANDROID_CLI_LICENSE_ID = "android-sdk-license";

const LICENSE_TITLES: Record<string, string> = {
  "android-sdk-license": "Android SDK License",
  "android-sdk-preview-license": "Android SDK Preview License",
  "android-sdk-arm-dbt-license": "Android SDK ARM Image License",
  "intel-android-sysimage-license": "Intel System Image License",
};

const PART_LABELS: Record<AndroidSdkSetupPartId, string> = {
  "platform-tools": "Platform tools",
  emulator: "Emulator",
  "cmdline-tools": "Command-line tools",
  "system-image": "Phone image",
  "android-cli": "Android CLI",
};

/** The install order: the small parts first, so a slow link shows progress at once. */
const PART_ORDER: AndroidSdkSetupPartId[] = ["platform-tools", "cmdline-tools", "emulator", "system-image", "android-cli"];

export type AndroidSdkInstallDeps = {
  platform?: NodeJS.Platform;
  machine?: string;
  env?: Readonly<Record<string, string | undefined>>;
  home?: string;
  fetchImpl?: typeof fetch;
  logger?: { info(event: string, data?: Record<string, unknown>): void; warn(event: string, data?: Record<string, unknown>): void } | null;
};

/** The platform's default SDK folder, the one Android Studio installs to. */
export function androidDefaultInstallRoot(platform: NodeJS.Platform, env: Readonly<Record<string, string | undefined>>, home: string): string {
  if (platform === "darwin") return path.join(home, "Library", "Android", "sdk");
  if (platform === "win32") return path.join(env.LOCALAPPDATA || path.join(home, "AppData", "Local"), "Android", "Sdk");
  return path.join(home, "Android", "Sdk");
}

/** `system-images;android-36;google_apis_playstore;arm64-v8a` → `<root>/system-images/android-36/…`. */
export function androidPackageDir(sdkRoot: string, packagePath: string): string {
  return path.join(sdkRoot, ...packagePath.split(";"));
}

/** The nearest folder that exists, for a disk-space read of a folder not made yet. */
function nearestExistingDir(target: string): string | null {
  let current = path.resolve(target);
  for (;;) {
    try {
      if (fs.statSync(current).isDirectory()) return current;
    } catch {
      // Keep walking up.
    }
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

export function freeBytesAt(target: string | null): number | null {
  if (!target) return null;
  const dir = nearestExistingDir(target);
  if (!dir) return null;
  try {
    const stats = fs.statfsSync(dir);
    return Number(stats.bavail) * Number(stats.bsize);
  } catch {
    return null;
  }
}

/** Can ADE make and write the folder? Checked on the nearest existing parent, with no files left behind. */
function checkWritable(target: string): { writable: boolean; detail: string | null } {
  const dir = nearestExistingDir(target);
  if (!dir) return { writable: false, detail: "The folder's drive is not there." };
  try {
    fs.accessSync(dir, fs.constants.W_OK);
  } catch {
    return { writable: false, detail: `ADE cannot write to ${dir}.` };
  }
  if (fs.existsSync(target)) {
    try {
      if (!fs.statSync(target).isDirectory()) return { writable: false, detail: `${target} is a file, not a folder.` };
    } catch {
      // Unreadable: the access check above decides.
    }
  }
  return { writable: true, detail: null };
}

function sha1Hex(text: string): string {
  return createHash("sha1").update(text, "utf8").digest("hex");
}

/** Hashes in `<root>/licenses/<id>` (one per line, sdkmanager's format). */
function readAcceptedHashes(sdkRoot: string, licenseId: string): Set<string> {
  try {
    return new Set(fs.readFileSync(path.join(sdkRoot, "licenses", licenseId), "utf8").split(/\r?\n/u).map((line) => line.trim()).filter(Boolean));
  } catch {
    return new Set();
  }
}

function licenseAccepted(sdkRoot: string, licenseId: string, text: string): boolean {
  const hashes = readAcceptedHashes(sdkRoot, licenseId);
  const known = KNOWN_LICENSE_HASHES[licenseId];
  return hashes.has(sha1Hex(text)) || (known !== undefined && hashes.has(known));
}

/** Appends the acceptance hashes and records who accepted what and when. */
function writeLicenseAcceptance(sdkRoot: string, license: { id: string; text: string }, now: Date): void {
  const dir = path.join(sdkRoot, "licenses");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, license.id);
  const existing = readAcceptedHashes(sdkRoot, license.id);
  const add = [KNOWN_LICENSE_HASHES[license.id], sha1Hex(license.text)].filter((hash): hash is string => Boolean(hash) && !existing.has(hash!));
  if (add.length > 0) fs.appendFileSync(file, add.map((hash) => `\n${hash}`).join(""), "utf8");
  const consentFile = path.join(sdkRoot, CONSENT_FILE);
  fs.mkdirSync(path.dirname(consentFile), { recursive: true });
  let records: unknown[] = [];
  try {
    const parsed = JSON.parse(fs.readFileSync(consentFile, "utf8")) as unknown;
    if (Array.isArray(parsed)) records = parsed;
  } catch {
    // First record, or an unreadable file: start a new list.
  }
  records.push({ licenseId: license.id, textSha1: sha1Hex(license.text), acceptedAt: now.toISOString(), acceptedIn: "ADE setup card" });
  fs.writeFileSync(consentFile, `${JSON.stringify(records, null, 2)}\n`, "utf8");
}

/** A `package.xml` like the one sdkmanager writes, from the manifest's own package XML. */
function buildPackageXml(manifest: AndroidRepoManifest, pkg: AndroidRepoPackage): string {
  const inner = pkg.innerXml
    .replace(/<channelRef[^>]*\/>/gu, "")
    .replace(/<archives>[\s\S]*?<\/archives>/gu, "")
    .trim();
  const licenseText = pkg.licenseId ? manifest.licenses.get(pkg.licenseId) : null;
  const escape = (text: string) => text.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;");
  const namespaces = manifest.namespaces.includes("xmlns:common=")
    ? manifest.namespaces
    : `${manifest.namespaces} xmlns:common="http://schemas.android.com/repository/android/common/02"`;
  return [
    "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>",
    `<common:repository ${namespaces.trim()}>`,
    licenseText && pkg.licenseId ? `<license id="${pkg.licenseId}" type="text">${escape(licenseText)}</license>` : "",
    `<localPackage path="${pkg.path}" obsolete="false">${inner}</localPackage>`,
    "</common:repository>",
    "",
  ].filter((line) => line !== "").join("\n");
}

/* ---------- the plan ---------- */

type PlannedPart = {
  part: AndroidSdkSetupPart;
  pkg: AndroidRepoPackage | null;
  archive: AndroidRepoArchive | null;
  manifest: AndroidRepoManifest | null;
};

export type AndroidSdkPlanInput = {
  sdk: AndroidSdkStatus;
  /** The folder the user picked with the pencil. */
  chosenRoot?: string | null;
  includeAndroidCli?: boolean;
};

function bytesOf(archive: AndroidRepoArchive | null): number {
  return archive?.size ?? 0;
}

function installedVersionOf(sdk: AndroidSdkStatus, id: AndroidSdkSetupPartId): string | null {
  const tool = sdk.tools.find((entry) => entry.id === id);
  return tool?.available ? tool.version : null;
}

/** Fills in every part the setup card shows, from the SDK status and (when reachable) Google's manifests. */
async function planParts(
  input: AndroidSdkPlanInput,
  installRoot: string,
  deps: Required<Pick<AndroidSdkInstallDeps, "platform" | "machine">> & AndroidSdkInstallDeps,
): Promise<{ parts: PlannedPart[]; manifests: AndroidRepoManifest[]; repositoryError: string | null }> {
  const sameRoot = input.sdk.found && input.sdk.root && path.resolve(input.sdk.root) === path.resolve(installRoot);
  // A new folder starts empty: every part is missing there even when another SDK has it.
  const status: AndroidSdkStatus = sameRoot ? input.sdk : { ...input.sdk, found: false, root: null, tools: [] };
  const host = androidRepoHost(deps.platform, deps.machine);
  let manifests: { main: AndroidRepoManifest; images: AndroidRepoManifest[] } | null = null;
  let repositoryError: string | null = null;
  if (host) {
    try {
      manifests = await fetchAndroidSetupManifests({ fetchImpl: deps.fetchImpl as AndroidRepoFetch | undefined });
    } catch (error) {
      repositoryError = `Google's SDK repository could not be read: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
  const plan = (id: AndroidSdkSetupPartId, pkg: AndroidRepoPackage | null, manifest: AndroidRepoManifest | null, detail: string | null): PlannedPart => {
    const installedVersion = installedVersionOf(status, id);
    const archive = pkg && host ? pickAndroidArchive(pkg, host) : null;
    const downloadBytes = bytesOf(archive);
    return {
      part: {
        id,
        label: PART_LABELS[id],
        packagePath: pkg?.path ?? null,
        version: pkg?.revision ?? null,
        installedVersion,
        missing: installedVersion === null,
        optional: false,
        downloadBytes,
        installedBytes: Math.round(downloadBytes * UNPACK_FACTOR[id]),
        licenseId: pkg?.licenseId ?? null,
        detail,
      },
      pkg,
      archive,
      manifest,
    };
  };
  const main = manifests?.main ?? null;
  const emulatorPkg = main && host ? newestStablePackage(main, "emulator", host) : null;
  const installedEmulator = installedVersionOf(status, "emulator");
  const emulatorRevision = installedEmulator
    ? installedEmulator.split(".").map(Number)
    : emulatorPkg?.revisionParts ?? null;
  const imagePkg = manifests ? pickAndroidSetupImage(manifests.images, status.hostAbi, emulatorRevision) : null;
  const imageManifest = imagePkg ? manifests!.images.find((manifest) => manifest.packages.includes(imagePkg)) ?? null : null;
  const imageDetail = imagePkg
    ? `API ${imagePkg.apiLevel} · ${imagePkg.tag === "google_apis_playstore" ? "Google Play" : "Google APIs"} · ${status.hostAbi === "arm64-v8a" ? "arm64" : "x86_64"}`
    : `${status.hostAbi === "arm64-v8a" ? "arm64" : "x86_64"} image`;
  const parts: PlannedPart[] = [
    plan("platform-tools", main && host ? newestStablePackage(main, "platform-tools", host) : null, main, "adb"),
    plan("cmdline-tools", main && host ? newestStablePackage(main, "cmdline-tools;latest", host) : null, main, "Device profiles"),
    plan("emulator", emulatorPkg, main, null),
    plan("system-image", imagePkg, imageManifest, imageDetail),
  ];
  // An installed emulator older than the image needs counts as missing: the image would not boot.
  const emulatorPart = parts.find((entry) => entry.part.id === "emulator")!;
  const imageNeeds = imagePkg?.dependencies.find((dependency) => dependency.path === "emulator")?.minRevision ?? null;
  if (installedEmulator && imageNeeds && compareRevisions(installedEmulator.split(".").map(Number), imageNeeds) < 0 && emulatorPkg) {
    emulatorPart.part.missing = true;
    emulatorPart.part.detail = `Update from ${installedEmulator}`;
  }
  const cli = await locateAndroidCli({ sdkRoot: sameRoot ? installRoot : null, env: deps.env, platform: deps.platform });
  const cliUrl = androidCliDownloadUrl(deps.platform, deps.machine);
  parts.push({
    part: {
      id: "android-cli",
      label: PART_LABELS["android-cli"],
      packagePath: null,
      version: cli?.version ?? null,
      installedVersion: cli?.version ?? null,
      missing: !cli && Boolean(input.includeAndroidCli) && Boolean(cliUrl),
      optional: true,
      // About 3.5 MB; it unpacks ~150 MB into the Android user folder on first run.
      downloadBytes: cli || !cliUrl ? 0 : 3_700_000,
      installedBytes: cli || !cliUrl ? 0 : 160_000_000,
      licenseId: ANDROID_CLI_LICENSE_ID,
      detail: cli ? (cli.source === "path" ? cli.path : "Installed by ADE") : cliUrl ? "Optional · UI tree, Compose previews" : "Not available for this computer",
    },
    pkg: null,
    archive: null,
    manifest: main,
  });
  return { parts, manifests: manifests ? [manifests.main, ...manifests.images] : [], repositoryError };
}

export async function buildAndroidSdkSetupPlan(
  input: AndroidSdkPlanInput,
  install: AndroidSdkInstallState,
  acceleration: AndroidAcceleration,
  deps: AndroidSdkInstallDeps = {},
): Promise<{ plan: AndroidSdkSetupPlan; planned: PlannedPart[]; manifests: AndroidRepoManifest[] }> {
  const platform = deps.platform ?? process.platform;
  const machine = deps.machine ?? (typeof os.machine === "function" ? os.machine() : process.arch);
  const env = deps.env ?? process.env;
  const home = deps.home ?? os.homedir();
  const chosen = input.chosenRoot?.trim() ? path.resolve(input.chosenRoot.trim()) : null;
  const sdkRoot = chosen ?? (input.sdk.found && input.sdk.root ? input.sdk.root : androidDefaultInstallRoot(platform, env, home));
  const sdkRootSource: AndroidSdkSetupPlan["sdkRootSource"] = chosen ? "chosen" : input.sdk.found ? "found" : "default";
  const host = androidRepoHost(platform, machine);
  const { parts: planned, manifests, repositoryError } = await planParts(input, sdkRoot, { ...deps, platform, machine, env });
  const parts = planned.map((entry) => entry.part);
  const missing = parts.filter((part) => part.missing);
  const licenseParts = new Map<string, AndroidSdkSetupPartId[]>();
  for (const part of missing) {
    if (!part.licenseId) continue;
    licenseParts.set(part.licenseId, [...(licenseParts.get(part.licenseId) ?? []), part.id]);
  }
  const licenses: AndroidSdkLicense[] = [];
  for (const [id, partIds] of licenseParts) {
    const text = androidLicenseText(manifests, id);
    if (!text) continue;
    licenses.push({ id, title: LICENSE_TITLES[id] ?? id, text, accepted: licenseAccepted(sdkRoot, id, text), partIds });
  }
  const downloadBytes = missing.reduce((sum, part) => sum + part.downloadBytes, 0);
  const largestZip = missing.reduce((max, part) => Math.max(max, part.downloadBytes), 0);
  const diskBytesNeeded = missing.reduce((sum, part) => sum + part.installedBytes, 0) + largestZip;
  const writable = checkWritable(sdkRoot);
  return {
    plan: {
      hostSupported: host !== null,
      unsupportedReason: host ? null : platform === "win32" || platform === "linux"
        ? `Google publishes no Android emulator for ${platform === "win32" ? "Windows" : "Linux"} on Arm. ADE cannot set up Android on this machine.`
        : `Google publishes no Android emulator for ${platform}.`,
      sdkRoot,
      sdkRootSource,
      existingSdkRoot: input.sdk.found ? input.sdk.root : null,
      parts,
      licenses,
      downloadBytes,
      diskBytesNeeded,
      diskBytesFree: freeBytesAt(sdkRoot),
      writable: writable.writable,
      writableDetail: writable.detail,
      avdHome: input.sdk.avdHome,
      avdHomeFreeBytes: freeBytesAt(input.sdk.avdHome),
      acceleration,
      repositoryError,
      install,
      checkedAt: new Date().toISOString(),
    },
    planned,
    manifests,
  };
}

/* ---------- the job ---------- */

type InstallJob = {
  id: string;
  sdkRoot: string;
  abort: AbortController;
  done: Promise<void>;
};

type InstallerListener = (state: AndroidSdkInstallState) => void;

/**
 * One installer per process: every project's Android service shares it, so a
 * second window or project sees the same progress and cannot start a second
 * download into the same folder.
 */
class AndroidSdkInstaller {
  state: AndroidSdkInstallState = { state: "idle" };
  private job: InstallJob | null = null;
  private listeners = new Set<InstallerListener>();
  private lastEmit = 0;

  subscribe(listener: InstallerListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private set(next: AndroidSdkInstallState, force = true): void {
    this.state = next;
    const now = Date.now();
    if (!force && now - this.lastEmit < PROGRESS_INTERVAL_MS) return;
    this.lastEmit = now;
    for (const listener of this.listeners) {
      try {
        listener(next);
      } catch {
        // A broken listener must not stop the install.
      }
    }
  }

  isRunning(): boolean {
    return this.job !== null;
  }

  cancel(): AndroidSdkInstallState {
    if (!this.job || this.state.state !== "running") return this.state;
    this.set({ ...this.state, cancelling: true });
    this.job.abort.abort();
    return this.state;
  }

  start(args: {
    sdkRoot: string;
    planned: PlannedPart[];
    manifests: AndroidRepoManifest[];
    acceptedLicenseIds: readonly string[];
    deps: AndroidSdkInstallDeps;
    onFinished: (state: AndroidSdkInstallState) => void;
  }): AndroidSdkInstallState {
    if (this.job) throw new AndroidEmulatorFailure("ANDROID_SDK_INSTALL_BUSY", "An Android SDK install already runs on this machine.");
    const missing = PART_ORDER.map((id) => args.planned.find((entry) => entry.part.id === id)).filter((entry): entry is PlannedPart => Boolean(entry?.part.missing));
    if (missing.length === 0) {
      const state: AndroidSdkInstallState = { state: "done", jobId: randomUUID(), sdkRoot: args.sdkRoot, finishedAt: new Date().toISOString(), installed: [] };
      this.set(state);
      return state;
    }
    const lock = acquireInstallLock(args.sdkRoot);
    const abort = new AbortController();
    const id = randomUUID();
    const startedAt = new Date().toISOString();
    const overallTotal = missing.reduce((sum, entry) => sum + entry.part.downloadBytes, 0);
    const installed: AndroidSdkSetupPartId[] = [];
    let overallBase = 0;
    const speed = new SpeedMeter();
    const progress = (entry: PlannedPart, index: number, step: "download" | "verify" | "unpack" | "finish", bytesDone: number, bytesTotal: number, force = false) => {
      const overallDone = overallBase + (step === "download" ? bytesDone : entry.part.downloadBytes);
      if (step === "download") speed.add(overallDone);
      const remaining = Math.max(0, overallTotal - overallDone);
      const rate = speed.rate();
      this.set({
        state: "running",
        jobId: id,
        sdkRoot: args.sdkRoot,
        startedAt,
        step,
        partId: entry.part.id,
        partLabel: entry.part.label,
        partIndex: index,
        partCount: missing.length,
        bytesDone,
        bytesTotal,
        overallDone,
        overallTotal,
        etaSeconds: rate > 0 ? Math.round(remaining / rate) : null,
        cancelling: abort.signal.aborted,
      }, force);
    };
    const run = async () => {
      let current: PlannedPart | null = null;
      try {
        for (const licenseId of new Set(missing.map((entry) => entry.part.licenseId).filter((value): value is string => Boolean(value)))) {
          const text = androidLicenseText(args.manifests, licenseId);
          if (text) writeLicenseAcceptance(args.sdkRoot, { id: licenseId, text }, new Date());
        }
        for (const [index, entry] of missing.entries()) {
          current = entry;
          abort.signal.throwIfAborted();
          progress(entry, index, "download", 0, entry.part.downloadBytes, true);
          if (entry.part.id === "android-cli") {
            await installAndroidCli(args.sdkRoot, args.deps, abort.signal, (done, total) => progress(entry, index, "download", done, total));
          } else {
            await installPackage(args.sdkRoot, entry, args.deps, abort.signal, (step, done, total) => progress(entry, index, step, done, total));
          }
          installed.push(entry.part.id);
          overallBase += entry.part.downloadBytes;
          args.deps.logger?.info("android.sdk_install.part_done", { part: entry.part.id, version: entry.part.version });
        }
        this.set({ state: "done", jobId: id, sdkRoot: args.sdkRoot, finishedAt: new Date().toISOString(), installed: [...installed] });
      } catch (error) {
        if (abort.signal.aborted) {
          this.set({ state: "cancelled", jobId: id, sdkRoot: args.sdkRoot, finishedAt: new Date().toISOString(), installed: [...installed] });
        } else {
          const failure = error instanceof AndroidEmulatorFailure ? error : null;
          const message = error instanceof Error ? error.message : String(error);
          args.deps.logger?.warn("android.sdk_install.failed", { part: current?.part.id ?? null, error: message });
          this.set({
            state: "failed",
            jobId: id,
            sdkRoot: args.sdkRoot,
            finishedAt: new Date().toISOString(),
            partId: current?.part.id ?? null,
            error: { code: failure?.code ?? "ANDROID_SDK_INSTALL_FAILED", message: failure ? failure.message : `${current?.part.label ?? "The install"} failed: ${message}` },
            installed: [...installed],
          });
        }
      } finally {
        // Empty work folders go; a folder that still holds a partial download
        // stays for the resume.
        for (const dir of [DOWNLOADS_DIR, STAGING_DIR]) {
          try {
            fs.rmdirSync(path.join(args.sdkRoot, dir));
          } catch {
            // Not empty, or not there.
          }
        }
        lock.release();
        this.job = null;
        try {
          args.onFinished(this.state);
        } catch {
          // The caller's follow-up (events, status) must not break the job's end.
        }
      }
    };
    this.job = { id, sdkRoot: args.sdkRoot, abort, done: Promise.resolve() };
    const first = missing[0]!;
    progress(first, 0, "download", 0, first.part.downloadBytes, true);
    this.job.done = run();
    return this.state;
  }
}

class SpeedMeter {
  private samples: Array<{ at: number; bytes: number }> = [];
  add(bytes: number): void {
    const now = Date.now();
    this.samples.push({ at: now, bytes });
    while (this.samples.length > 2 && now - this.samples[0]!.at > 8_000) this.samples.shift();
  }
  /** Bytes per second over the last few seconds. */
  rate(): number {
    if (this.samples.length < 2) return 0;
    const first = this.samples[0]!;
    const last = this.samples[this.samples.length - 1]!;
    const seconds = (last.at - first.at) / 1000;
    return seconds > 0.5 ? (last.bytes - first.bytes) / seconds : 0;
  }
}

let sharedInstaller: AndroidSdkInstaller | null = null;
export function androidSdkInstaller(): AndroidSdkInstaller {
  sharedInstaller ??= new AndroidSdkInstaller();
  return sharedInstaller;
}

/* ---------- lock ---------- */

function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * `<sdk>/.ade-install.lock` holds the pid of the process that installs. A
 * second ADE process on the machine (the desktop's own runtime, another
 * brain) is refused while that pid lives.
 */
function acquireInstallLock(sdkRoot: string): { release(): void } {
  fs.mkdirSync(sdkRoot, { recursive: true });
  const lockPath = path.join(sdkRoot, LOCK_FILE);
  const body = JSON.stringify({ pid: process.pid, at: new Date().toISOString() });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      fs.writeFileSync(lockPath, body, { flag: "wx" });
      return {
        release() {
          try {
            const held = JSON.parse(fs.readFileSync(lockPath, "utf8")) as { pid?: number };
            if (held.pid === process.pid) fs.rmSync(lockPath, { force: true });
          } catch {
            // Already gone.
          }
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let held: { pid?: number; at?: string } = {};
      try {
        held = JSON.parse(fs.readFileSync(lockPath, "utf8")) as typeof held;
      } catch {
        // Unreadable lock: treat as stale.
      }
      const age = held.at ? Date.now() - Date.parse(held.at) : Number.POSITIVE_INFINITY;
      if (held.pid && held.pid !== process.pid && pidAlive(held.pid) && age < LOCK_STALE_MS) {
        throw new AndroidEmulatorFailure("ANDROID_SDK_INSTALL_BUSY", `Another ADE process (pid ${held.pid}) installs into ${sdkRoot}.`);
      }
      fs.rmSync(lockPath, { force: true });
    }
  }
  throw new AndroidEmulatorFailure("ANDROID_SDK_INSTALL_BUSY", `ADE could not lock ${sdkRoot} for the install.`);
}

/* ---------- download ---------- */

/**
 * Downloads `url` to `target` with resume (`Range`) and up to four attempts,
 * hashing as it goes. A partial file from an earlier, cancelled install is
 * hashed first and continued.
 */
async function downloadVerified(args: {
  url: string;
  target: string;
  size: number;
  hash: { algorithm: "sha1" | "sha256"; hex: string };
  fetchImpl: typeof fetch;
  signal: AbortSignal;
  onProgress: (done: number, total: number) => void;
}): Promise<void> {
  const part = `${args.target}.part`;
  fs.mkdirSync(path.dirname(part), { recursive: true });
  let lastError: unknown = null;
  for (let attempt = 0; attempt < DOWNLOAD_ATTEMPTS; attempt += 1) {
    args.signal.throwIfAborted();
    let have = 0;
    try {
      have = fs.statSync(part).size;
    } catch {
      have = 0;
    }
    if (args.size > 0 && have > args.size) {
      fs.rmSync(part, { force: true });
      have = 0;
    }
    const hash = createHash(args.hash.algorithm);
    if (have > 0) {
      for await (const chunk of fs.createReadStream(part, { signal: args.signal })) hash.update(chunk as Buffer);
    }
    try {
      if (args.size > 0 && have === args.size) {
        // Already complete from an earlier run; only the check is left.
      } else {
        const response = await args.fetchImpl(args.url, {
          headers: have > 0 ? { Range: `bytes=${have}-` } : {},
          signal: args.signal,
        });
        if (have > 0 && response.status === 200) {
          // The server ignored the range: start over.
          await response.body?.cancel();
          fs.rmSync(part, { force: true });
          continue;
        }
        if (!response.ok || !response.body) throw new Error(`the server answered ${response.status}`);
        const sink = fs.createWriteStream(part, { flags: have > 0 ? "a" : "w" });
        let done = have;
        try {
          for await (const chunk of Readable.fromWeb(response.body as import("node:stream/web").ReadableStream<Uint8Array>, { signal: args.signal })) {
            const buffer = chunk as Buffer;
            hash.update(buffer);
            done += buffer.length;
            if (!sink.write(buffer)) await new Promise<void>((resolve) => sink.once("drain", resolve));
            args.onProgress(done, args.size || done);
          }
        } finally {
          await new Promise<void>((resolve) => sink.end(resolve));
        }
      }
      const digest = hash.digest("hex");
      if (digest !== args.hash.hex.toLowerCase()) {
        fs.rmSync(part, { force: true });
        throw new Error(`the download's ${args.hash.algorithm.toUpperCase()} does not match Google's (${path.basename(args.url)})`);
      }
      fs.renameSync(part, args.target);
      return;
    } catch (error) {
      if (args.signal.aborted) throw error;
      lastError = error;
      if (error instanceof Error && /does not match/u.test(error.message) && attempt >= 1) break;
      await new Promise((resolve) => setTimeout(resolve, 1_000 * (attempt + 1)));
    }
  }
  throw new Error(lastError instanceof Error ? lastError.message : String(lastError ?? "the download failed"));
}

/* ---------- one package ---------- */

async function installPackage(
  sdkRoot: string,
  entry: PlannedPart,
  deps: AndroidSdkInstallDeps,
  signal: AbortSignal,
  onProgress: (step: "download" | "verify" | "unpack" | "finish", done: number, total: number) => void,
): Promise<void> {
  const { pkg, archive, manifest } = entry;
  if (!pkg || !archive || !manifest) {
    throw new AndroidEmulatorFailure("ANDROID_SDK_INSTALL_FAILED", `${entry.part.label} is not available from Google's repository for this computer.`);
  }
  const fetchImpl = deps.fetchImpl ?? fetch;
  const zipPath = path.join(sdkRoot, DOWNLOADS_DIR, `${archive.sha1}-${path.basename(new URL(archive.url).pathname)}`);
  await downloadVerified({
    url: archive.url,
    target: zipPath,
    size: archive.size,
    hash: { algorithm: "sha1", hex: archive.sha1 },
    fetchImpl,
    signal,
    onProgress: (done, total) => onProgress("download", done, total),
  });
  onProgress("unpack", 0, archive.size);
  const staging = path.join(sdkRoot, STAGING_DIR, `${entry.part.id}-${randomUUID().slice(0, 8)}`);
  const finalDir = androidPackageDir(sdkRoot, pkg.path);
  let movedAside: string | null = null;
  try {
    const top = zipCommonRoot(readZipEntries(zipPath));
    await extractZip(zipPath, staging, {
      signal,
      platform: deps.platform,
      onProgress: (progress) => onProgress("unpack", progress.bytesDone, progress.bytesTotal),
    });
    onProgress("finish", 0, 1);
    const unpacked = top ? path.join(staging, top) : staging;
    fs.writeFileSync(path.join(unpacked, "package.xml"), buildPackageXml(manifest, pkg), "utf8");
    fs.mkdirSync(path.dirname(finalDir), { recursive: true });
    if (fs.existsSync(finalDir)) {
      // An older or broken copy (no `source.properties`, or an emulator too old for the image).
      movedAside = `${finalDir}.ade-old-${Date.now()}`;
      fs.renameSync(finalDir, movedAside);
    }
    await renameWithRetry(unpacked, finalDir, deps.platform ?? process.platform);
    if (movedAside) {
      fs.rmSync(movedAside, { recursive: true, force: true, maxRetries: 3 });
      movedAside = null;
    }
    fs.rmSync(zipPath, { force: true });
  } catch (error) {
    if (movedAside && !fs.existsSync(finalDir)) {
      try {
        fs.renameSync(movedAside, finalDir);
      } catch {
        // Leave it; the next plan reads the part as missing and installs it again.
      }
    }
    throw error;
  } finally {
    fs.rmSync(staging, { recursive: true, force: true, maxRetries: 3 });
  }
}

/** Windows antivirus can hold a fresh folder for a moment; retry the move a few times. */
async function renameWithRetry(from: string, to: string, platform: NodeJS.Platform): Promise<void> {
  const attempts = platform === "win32" ? 6 : 1;
  for (let attempt = 0; ; attempt += 1) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (attempt + 1 >= attempts || (code !== "EPERM" && code !== "EBUSY" && code !== "EACCES")) throw error;
      await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
    }
  }
}

/* ---------- the Android CLI ---------- */

async function installAndroidCli(
  sdkRoot: string,
  deps: AndroidSdkInstallDeps,
  signal: AbortSignal,
  onProgress: (done: number, total: number) => void,
): Promise<void> {
  const platform = deps.platform ?? process.platform;
  const machine = deps.machine ?? (typeof os.machine === "function" ? os.machine() : process.arch);
  const url = androidCliDownloadUrl(platform, machine);
  if (!url) throw new AndroidEmulatorFailure("ANDROID_SDK_INSTALL_FAILED", "Google publishes no Android CLI for this computer.");
  const fetchImpl = deps.fetchImpl ?? fetch;
  const checksum = await fetchImpl(`${url}.sha256`, { signal });
  if (!checksum.ok) throw new Error(`the Android CLI checksum answered ${checksum.status}`);
  const sha256 = (await checksum.text()).trim().split(/\s+/u)[0]?.toLowerCase() ?? "";
  if (!/^[0-9a-f]{64}$/u.test(sha256)) throw new Error("the Android CLI checksum is not a SHA-256");
  const target = androidCliInstallPath(sdkRoot, platform);
  const download = `${target}.download`;
  fs.rmSync(`${download}.part`, { force: true });
  await downloadVerified({ url, target: download, size: 0, hash: { algorithm: "sha256", hex: sha256 }, fetchImpl, signal, onProgress });
  if (platform !== "win32") fs.chmodSync(download, 0o755);
  fs.renameSync(download, target);
  // The first run unpacks the CLI's bundle; do it now, with metrics off, so the first agent call is fast.
  await readAndroidCliVersion(target);
  deps.logger?.info("android.sdk_install.cli_ready", { args: androidCliArgs(null, ["--version"]).join(" ") });
}
