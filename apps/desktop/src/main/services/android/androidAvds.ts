import fs from "node:fs";
import path from "node:path";
import type { AndroidAvd, AndroidRunningEmulator, AndroidSystemImage } from "../../../shared/types/androidEmulator";
import { androidAvdDisplayName } from "../../../shared/androidDevicePresentation";
import { AndroidEmulatorFailure } from "./androidEmulatorErrors";
import { androidHardwareConfig, type AndroidDeviceDefinition } from "./androidHardwareProfiles";
import { readAndroidIniFile } from "./androidSdk";
import { REMOTE_WORK_LANE_PREFIX } from "../remoteWork/remoteWorkCopyService";

/*
 * The AVDs on this machine: list them, make one for a lane, delete one ADE
 * made.
 *
 * An AVD is two files' worth of state: `<avdHome>/<name>.ini` (where the
 * folder is) and `<name>.avd/config.ini` (the hardware and the system image).
 * The emulator builds the disks from the image on first boot. So listing reads
 * those files (no `avdmanager`, no JDK), and creating writes them the way
 * Android Studio does.
 *
 * Ownership: an AVD ADE made carries `ade.created=true` and the lane id in
 * its `config.ini`. ADE deletes only those, never a user's AVD. If a tool
 * rewrites `config.ini` and drops the keys, the AVD reads as the user's and is
 * kept: the safe direction.
 */

const ADE_AVD_CREATED_KEY = "ade.created";
const ADE_AVD_LANE_KEY = "ade.laneId";
const ADE_AVD_CREATED_AT_KEY = "ade.createdAt";
/** P1 look: the brand catalog entry and the body colour, so any window draws the right body. */
const ADE_AVD_CATALOG_KEY = "ade.catalogId";
const ADE_AVD_COLOR_KEY = "ade.color";

/** The AVD names the emulator accepts: letters, digits, `.`, `_`, `-`. */
const AVD_NAME_PATTERN = /^[A-Za-z0-9._-]+$/u;

/** AVD names compare without case: the AVD folders live on case-insensitive disks (Windows, macOS). */
export const sameAvdName = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

function avdFolder(avdHome: string, name: string, ini: Map<string, string> | null): string {
  const declared = ini?.get("path");
  if (declared && fs.existsSync(declared)) return path.resolve(declared);
  return path.join(avdHome, `${name}.avd`);
}

function apiLevelOf(ini: Map<string, string> | null, config: Map<string, string>): number | null {
  const target = ini?.get("target") ?? config.get("target") ?? config.get("image.sysdir.1") ?? "";
  const match = /android-(\d+)/u.exec(target);
  return match ? Number(match[1]) : null;
}

function intOrNull(value: string | undefined): number | null {
  if (value === undefined || value === "") return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

/** `hw.ramSize` from `config.ini`: `2048`, `2048M`, `2048MB` or `2G`. */
export function parseAndroidRamSizeMb(value: string | undefined | null): number | null {
  const match = /^\s*(\d+(?:\.\d+)?)\s*([mg])?b?\s*$/i.exec(value ?? "");
  if (!match) return null;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  return Math.round(match[2]?.toLowerCase() === "g" ? amount * 1024 : amount);
}

/**
 * An AVD folder's bytes on disk, without blocking: the folder can be many GB
 * on a slow drive, and the brain must keep answering while it is walked.
 */
export async function measureAndroidAvdBytes(dir: string): Promise<number> {
  let total = 0;
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile()) total += await fs.promises.stat(full).then((stat) => stat.size, () => 0);
    }
  }
  return total;
}

/**
 * The name a person sees: the one set for the AVD, or, when none was set (or
 * it is the folder name, as ADE writes it when none was asked for), the
 * folder name in words (`ade_ab12cd34_pixel_9` is "Pixel 9").
 */
function shownAvdName(name: string, configured: string | undefined): string {
  const set = configured?.trim();
  return set && set !== name ? set : androidAvdDisplayName(name);
}

/** One AVD by name, or null when it has no `<name>.ini` or no `config.ini`. */
export function readAndroidAvd(
  avdHome: string,
  name: string,
  options: { running?: readonly AndroidRunningEmulator[] } = {},
): AndroidAvd | null {
  const ini = readAndroidIniFile(path.join(avdHome, `${name}.ini`));
  if (!ini) return null;
  const folder = avdFolder(avdHome, name, ini);
  const config = readAndroidIniFile(path.join(folder, "config.ini"));
  if (!config) return null;
  return {
    name,
    displayName: shownAvdName(name, config.get("avd.ini.displayname")),
    profileId: config.get("hw.device.name") || null,
    apiLevel: apiLevelOf(ini, config),
    tag: config.get("tag.id") || null,
    abi: config.get("abi.type") || null,
    lcdWidth: intOrNull(config.get("hw.lcd.width")),
    lcdHeight: intOrNull(config.get("hw.lcd.height")),
    density: intOrNull(config.get("hw.lcd.density")),
    ramMb: parseAndroidRamSizeMb(config.get("hw.ramSize")),
    path: folder,
    sizeBytes: null,
    adeCreated: config.get(ADE_AVD_CREATED_KEY) === "true",
    catalogId: config.get(ADE_AVD_CATALOG_KEY) || null,
    colorId: config.get(ADE_AVD_COLOR_KEY) || null,
    running: options.running?.find((emulator) => emulator.avdName === name) ?? null,
  };
}

/** The lane an ADE-made AVD was made for, from its `config.ini`. */
export function readAdeAvdLaneId(avd: Pick<AndroidAvd, "path">): string | null {
  return readAndroidIniFile(path.join(avd.path, "config.ini"))?.get(ADE_AVD_LANE_KEY) || null;
}

/**
 * Every AVD in `avdHome`, by its `<name>.ini` (what `emulator -list-avds`
 * reads), sorted by name. A folder with no `.ini` is not an AVD the emulator
 * can boot, so it is not listed.
 */
export function listAndroidAvds(
  avdHome: string,
  options: { running?: readonly AndroidRunningEmulator[] } = {},
): AndroidAvd[] {
  let names: string[];
  try {
    names = fs.readdirSync(avdHome, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".ini"))
      .map((entry) => entry.name.slice(0, -".ini".length));
  } catch {
    return [];
  }
  return names
    .sort((a, b) => a.localeCompare(b))
    .map((name) => readAndroidAvd(avdHome, name, options))
    .filter((avd): avd is AndroidAvd => avd !== null);
}

/**
 * `ade_<short lane id>_<profile>`, plus `_2`, `_3`… when that name is taken.
 * Only AVD-name characters survive, so any lane id or profile id is safe. A
 * chat's work copy (`remote-work-<hash>`) is `rw` and its hash's start, so
 * two chats' AVDs differ by more than a suffix.
 */
function adeAvdName(laneId: string, profileId: string, taken: ReadonlySet<string>): string {
  const clean = (value: string) => value.replace(/[^A-Za-z0-9_]+/gu, "_").replace(/^_+|_+$/gu, "");
  const shortLane = (laneId.startsWith(REMOTE_WORK_LANE_PREFIX)
    ? `rw${clean(laneId.slice(REMOTE_WORK_LANE_PREFIX.length)).slice(0, 6)}`
    : clean(laneId).slice(0, 8)) || "lane";
  // An ADE catalog profile (`ade_galaxy_s25`) loses its own `ade_`: the name has one already.
  const base = `ade_${shortLane}_${clean(profileId).replace(/^ade_/iu, "") || "device"}`;
  const lowerTaken = new Set([...taken].map((name) => name.toLowerCase()));
  if (!lowerTaken.has(base.toLowerCase())) return base;
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${base}_${suffix}`;
    if (!lowerTaken.has(candidate.toLowerCase())) return candidate;
  }
}

function writeIni(filePath: string, values: Record<string, string>): void {
  // A control character in a value (a shown name from the CLI) would start a
  // new key line, so each becomes a space.
  const body = Object.entries(values)
    .map(([key, value]) => `${key}=${value.replace(/[\u0000-\u001f\u007f]/g, " ")}`)
    .join("\n");
  fs.writeFileSync(filePath, `${body}\n`, "utf8");
}

/** `system-images/android-36/google_apis_playstore/x86_64/`, relative to the SDK, with forward slashes. */
function imageSysdir(sdkRoot: string, image: AndroidSystemImage): string {
  const relative = path.relative(sdkRoot, image.path).split(path.sep).join("/");
  return relative.endsWith("/") ? relative : `${relative}/`;
}

function imageTarget(image: AndroidSystemImage): string {
  // `system-images;android-36;…` → `android-36`, which also covers `android-36.1`.
  return image.packageId.split(";")[1] || `android-${image.apiLevel}`;
}

/** `system-images;…;google_apis_playstore;…` first, then `google_apis`, then the rest. */
function imageTagRank(tag: string): number {
  if (tag === "google_apis_playstore") return 0;
  if (tag === "google_apis") return 1;
  if (tag === "default" || tag === "aosp_atd" || tag === "google_atd") return 2;
  return 3;
}

/** Tags that only fit their own form factor (a watch, a TV, a car, an XR headset). */
const SPECIAL_IMAGE_TAG = /wear|tv|automotive|xr|desktop/iu;

/**
 * The image a new AVD gets when the caller names none: the newest API level
 * for the host ABI, Play Store first within one level. A watch or TV profile
 * takes an image with its own tag; a phone never gets one of those.
 */
export function pickAndroidSystemImage(
  images: readonly AndroidSystemImage[],
  hostAbi: string,
  definition: Pick<AndroidDeviceDefinition, "tagId">,
): AndroidSystemImage | null {
  const wantedTag = definition.tagId?.trim() || null;
  const candidates = images.filter((image) =>
    image.abi === hostAbi
    && (wantedTag && SPECIAL_IMAGE_TAG.test(wantedTag) ? image.tag.includes(wantedTag) : !SPECIAL_IMAGE_TAG.test(image.tag)));
  candidates.sort((a, b) => b.apiLevel - a.apiLevel || imageTagRank(a.tag) - imageTagRank(b.tag) || a.packageId.localeCompare(b.packageId));
  return candidates[0] ?? null;
}

export type CreateAndroidAvdInput = {
  sdkRoot: string;
  avdHome: string;
  /** The user's Android config folder (`androidUserHome`), for `path.rel`. */
  userHome: string;
  laneId: string;
  definition: AndroidDeviceDefinition;
  image: AndroidSystemImage;
  /** What the picker shows (`ADE · checkout-flow`); defaults to the AVD name. */
  displayName?: string | null;
  ramMb?: number;
  /** P1 look: the catalog entry and colour, written as ADE's marker keys. */
  catalogId?: string | null;
  colorId?: string | null;
};

/**
 * Makes an empty AVD for a lane from a hardware profile and an installed
 * system image, the way Android Studio writes one. The emulator builds the
 * disks from the image on the first boot.
 *
 * `config.ini` is written first and `<name>.ini` last: until the `.ini`
 * exists the emulator does not list the AVD, so a create that fails half-way
 * leaves nothing bootable, and the folder is removed.
 */
export function createAndroidAvd(input: CreateAndroidAvdInput): AndroidAvd {
  const imageProps = readAndroidIniFile(path.join(input.image.path, "source.properties"));
  if (!imageProps) {
    throw new AndroidEmulatorFailure("ANDROID_NO_SYSTEM_IMAGE", `The system image ${input.image.packageId} is not installed.`);
  }
  fs.mkdirSync(input.avdHome, { recursive: true });
  const taken = new Set(listAvdNames(input.avdHome));
  const name = adeAvdName(input.laneId, input.definition.profile.id, taken);
  if (!AVD_NAME_PATTERN.test(name)) throw new Error(`Bad AVD name ${name}`);
  const folder = path.join(input.avdHome, `${name}.avd`);
  if (fs.existsSync(folder)) {
    throw new Error(`An AVD folder named ${name}.avd already exists without its .ini; ADE will not reuse it.`);
  }
  const target = imageTarget(input.image);
  const tag = input.image.tag;
  const tagDisplay = imageProps.get("SystemImage.TagDisplay") || tag;
  const config: Record<string, string> = {
    "AvdId": name,
    "avd.ini.displayname": input.displayName?.trim() || name,
    "avd.ini.encoding": "UTF-8",
    "abi.type": input.image.abi,
    "hw.cpu.arch": input.image.abi === "arm64-v8a" ? "arm64" : input.image.abi === "x86_64" ? "x86_64" : input.image.abi,
    "image.sysdir.1": imageSysdir(input.sdkRoot, input.image),
    "target": target,
    "tag.id": tag,
    "tag.display": tagDisplay,
    "PlayStore.enabled": String(/playstore/u.test(tag) && input.definition.playStore),
    ...androidHardwareConfig(input.definition, { ramMb: input.ramMb }),
    [ADE_AVD_CREATED_KEY]: "true",
    [ADE_AVD_LANE_KEY]: input.laneId,
    [ADE_AVD_CREATED_AT_KEY]: new Date().toISOString(),
    ...(input.catalogId ? { [ADE_AVD_CATALOG_KEY]: input.catalogId } : {}),
    ...(input.colorId ? { [ADE_AVD_COLOR_KEY]: input.colorId } : {}),
  };
  const relativeToUserHome = path.relative(input.userHome, folder);
  const pointer: Record<string, string> = {
    "avd.ini.encoding": "UTF-8",
    "path": folder,
    ...(relativeToUserHome && !relativeToUserHome.startsWith("..") && !path.isAbsolute(relativeToUserHome)
      ? { "path.rel": relativeToUserHome.split(path.sep).join("/") }
      : {}),
    "target": target,
  };
  fs.mkdirSync(folder);
  try {
    writeIni(path.join(folder, "config.ini"), config);
    writeIni(path.join(input.avdHome, `${name}.ini`), pointer);
  } catch (error) {
    fs.rmSync(folder, { recursive: true, force: true });
    fs.rmSync(path.join(input.avdHome, `${name}.ini`), { force: true });
    throw error;
  }
  const created = readAndroidAvd(input.avdHome, name);
  if (!created) throw new Error(`The new AVD ${name} could not be read back.`);
  return created;
}

function listAvdNames(avdHome: string): string[] {
  try {
    return fs.readdirSync(avdHome).flatMap((entry) => {
      if (entry.toLowerCase().endsWith(".ini")) return [entry.slice(0, -4)];
      if (entry.toLowerCase().endsWith(".avd")) return [entry.slice(0, -4)];
      return [];
    });
  } catch {
    return [];
  }
}

/**
 * Deletes an AVD ADE made: its folder (with the disks) and its `.ini`.
 *
 * Refuses an AVD without ADE's marker, one that is running, and one whose
 * folder is outside `avdHome` (an `.ini` pointing elsewhere is not ADE's
 * layout, so it is left alone).
 */
export function deleteAdeAndroidAvd(
  avdHome: string,
  name: string,
  running: readonly AndroidRunningEmulator[],
): void {
  const avd = readAndroidAvd(avdHome, name);
  if (!avd) throw new AndroidEmulatorFailure("ANDROID_AVD_NOT_FOUND", `No AVD named ${name} is on this machine.`);
  if (!avd.adeCreated) {
    throw new Error(`${name} was not created by ADE, so ADE will not delete it.`);
  }
  if (running.some((emulator) => emulator.avdName === name)) {
    throw new Error(`${name} is running. Stop it before deleting it.`);
  }
  const folder = path.resolve(avd.path);
  const home = path.resolve(avdHome);
  const same = (a: string, b: string) => (process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b);
  if (!same(path.dirname(folder), home) || !same(path.basename(folder), `${name}.avd`)) {
    throw new Error(`${name} lives at ${folder}, outside ${home}; ADE will not delete it.`);
  }
  // Rename the folder first. On Windows a running emulator holds it open, so
  // the rename fails and nothing has changed yet. Then the `.ini` (the
  // emulator stops listing the AVD), then the disks.
  const doomed = path.join(home, `${name}.avd.deleting-${process.pid}-${Date.now()}`);
  try {
    fs.renameSync(folder, doomed);
  } catch (error) {
    throw new Error(`${name} is in use and was not deleted: ${(error as Error).message}`);
  }
  fs.rmSync(path.join(home, `${name}.ini`), { force: true });
  fs.rmSync(doomed, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
}

/**
 * P1 look: records a body colour on an AVD (`ade.color` in its `config.ini`).
 * Only that one line changes; every other line, and the file's line endings,
 * stay as they were. The emulator ignores keys it does not know, and a
 * running emulator does not reread `config.ini`, so this is safe at any time.
 */
export function setAndroidAvdColor(avd: Pick<AndroidAvd, "path">, colorId: string): void {
  const value = colorId.replace(/[\u0000-\u001f\u007f]/g, "");
  const filePath = path.join(avd.path, "config.ini");
  const text = fs.readFileSync(filePath, "utf8");
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/u);
  const at = lines.findIndex((line) => line.split("=", 1)[0]?.trim() === ADE_AVD_COLOR_KEY);
  if (at >= 0) lines[at] = `${ADE_AVD_COLOR_KEY}=${value}`;
  else {
    // Before the trailing empty line, so the file still ends with one newline.
    const end = lines.length > 0 && lines[lines.length - 1] === "" ? lines.length - 1 : lines.length;
    lines.splice(end, 0, `${ADE_AVD_COLOR_KEY}=${value}`);
  }
  const temp = `${filePath}.ade-${process.pid}.tmp`;
  fs.writeFileSync(temp, lines.join(eol), "utf8");
  try {
    fs.renameSync(temp, filePath);
  } catch (error) {
    fs.rmSync(temp, { force: true });
    throw error;
  }
}
