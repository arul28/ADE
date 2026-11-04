import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import type { AndroidHardwareProfile } from "../../../shared/types/androidEmulator";
import { androidCmdlineToolsDir, androidUserHome, type AndroidEnv } from "./androidSdk";

/*
 * The hardware profiles an AVD can be made from (`medium_phone`,
 * `pixel_9_pro_fold`), and the `config.ini` keys each one turns into.
 *
 * Source: the device XML the SDK's own tools read, straight out of
 * `cmdline-tools/<ver>/lib/sdklib/*.jar` (a zip; Node's zlib inflates it). No
 * JDK, no process, about 90 profiles in a few milliseconds. `avdmanager list
 * device` reads the same files but needs a JDK and takes about a second.
 * Android Studio's own `sdklib.jar` is the fallback when cmdline-tools is not
 * installed. The user's `<user home>/devices.xml` adds their own profiles
 * (and, from P1, the `ade_*` catalog profiles ADE writes there).
 */

/** A profile plus the hardware fields `config.ini` needs. */
export type AndroidDeviceDefinition = {
  profile: AndroidHardwareProfile;
  manufacturer: string | null;
  ramMb: number | null;
  keyboard: boolean;
  dpad: boolean;
  trackball: boolean;
  hardButtons: boolean;
  sensors: string[];
  backCamera: boolean;
  frontCamera: boolean;
  mic: boolean;
  battery: boolean;
  playStore: boolean;
  /** `<d:tag-id>`: the system-image tag a non-phone profile needs (`android-wear`). */
  tagId: string | null;
  orientation: "portrait" | "landscape";
  /** The folded screen of a foldable, in pixels. */
  foldedRegion: { x: number; y: number; width: number; height: number } | null;
  /** `<d:hinge>` fields by name (`count`, `ranges`, `areas`, …). */
  hinge: Record<string, string> | null;
};

const SDKLIB_DEVICE_PREFIX = "com/android/sdklib/devices/";

/* ---------- zip (jar) reading ---------- */

/**
 * The entries of a zip whose names pass `wanted`, as text. Reads the central
 * directory (its sizes are right even when an entry uses a data descriptor),
 * then inflates only the wanted entries. Zip64 is not handled; an SDK jar is
 * a few MB.
 */
function readZipTextEntries(zipPath: string, wanted: (name: string) => boolean): Map<string, string> {
  const buffer = fs.readFileSync(zipPath);
  const eocd = findEndOfCentralDirectory(buffer);
  if (eocd < 0) throw new Error(`${zipPath} is not a zip file`);
  const entryCount = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  const entries = new Map<string, string>();
  for (let index = 0; index < entryCount; index += 1) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) throw new Error(`${zipPath}: bad central directory`);
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString("utf8", offset + 46, offset + 46 + nameLength);
    offset += 46 + nameLength + extraLength + commentLength;
    if (!wanted(name)) continue;
    if (buffer.readUInt32LE(localOffset) !== 0x04034b50) throw new Error(`${zipPath}: bad local header for ${name}`);
    const dataStart = localOffset + 30 + buffer.readUInt16LE(localOffset + 26) + buffer.readUInt16LE(localOffset + 28);
    const data = buffer.subarray(dataStart, dataStart + compressedSize);
    if (method === 0) entries.set(name, data.toString("utf8"));
    else if (method === 8) entries.set(name, zlib.inflateRawSync(data).toString("utf8"));
  }
  return entries;
}

function findEndOfCentralDirectory(buffer: Buffer): number {
  const lowest = Math.max(0, buffer.length - 65_557);
  for (let offset = buffer.length - 22; offset >= lowest; offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) return offset;
  }
  return -1;
}

/* ---------- device XML ---------- */

function decodeXml(text: string): string {
  return text
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/gu, "$1")
    .replace(/&lt;/gu, "<")
    .replace(/&gt;/gu, ">")
    .replace(/&quot;/gu, "\"")
    .replace(/&apos;/gu, "'")
    .replace(/&amp;/gu, "&")
    .trim();
}

/** Every `<d:tag …>body</d:tag>` in `xml` (any namespace prefix), as raw bodies. */
function elements(xml: string, tag: string): Array<{ attrs: string; body: string }> {
  const pattern = new RegExp(`<(?:[\\w-]+:)?${tag}(\\s[^>]*)?>([\\s\\S]*?)</(?:[\\w-]+:)?${tag}>`, "gu");
  return [...xml.matchAll(pattern)].map((match) => ({ attrs: match[1] ?? "", body: match[2] ?? "" }));
}

function text(xml: string, tag: string): string | null {
  const found = elements(xml, tag)[0];
  return found ? decodeXml(found.body) : null;
}

function numberOrNull(value: string | null): number | null {
  if (value === null || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** `420dpi` → 420; the named buckets map to their dpi. */
function parseDensity(value: string | null): number | null {
  if (!value) return null;
  const dpi = /^(\d+)dpi$/u.exec(value);
  if (dpi) return Number(dpi[1]);
  const buckets: Record<string, number> = { ldpi: 120, mdpi: 160, tvdpi: 213, hdpi: 240, xhdpi: 320, xxhdpi: 480, xxxhdpi: 640 };
  return buckets[value] ?? null;
}

/** `<d:ram unit="GiB">8</d:ram>` → MiB. */
function parseMegabytes(entry: { attrs: string; body: string } | undefined): number | null {
  if (!entry) return null;
  const amount = numberOrNull(decodeXml(entry.body));
  if (amount === null) return null;
  const unit = /unit="([^"]+)"/u.exec(entry.attrs)?.[1] ?? "MiB";
  const factor: Record<string, number> = { B: 1 / (1024 * 1024), KiB: 1 / 1024, MiB: 1, GiB: 1024, TiB: 1024 * 1024 };
  return Math.round(amount * (factor[unit] ?? 1));
}

function formFactor(tagId: string | null, hinge: boolean, diagonal: number | null, screenSize: string | null): string {
  const tag = tagId ?? "";
  if (/wear/u.test(tag)) return "wear";
  if (/tv/u.test(tag)) return "tv";
  if (/automotive/u.test(tag)) return "automotive";
  if (/desktop/u.test(tag)) return "desktop";
  if (/xr/u.test(tag)) return "xr";
  if (hinge) return "foldable";
  if ((diagonal !== null && diagonal >= 7) || screenSize === "xlarge") return "tablet";
  return "phone";
}

/**
 * The `<d:device>` entries of one device XML. A legacy entry with no `<d:id>`
 * (`Galaxy Nexus`) uses its name as the id, as `avdmanager` does.
 */
function parseAndroidDeviceXml(xml: string, origin: AndroidHardwareProfile["origin"]): AndroidDeviceDefinition[] {
  const definitions: AndroidDeviceDefinition[] = [];
  for (const device of elements(xml, "device")) {
    const body = device.body;
    const name = text(body, "name");
    const id = text(body, "id") || name;
    if (!id || !name) continue;
    const hardware = elements(body, "hardware")[0]?.body ?? "";
    const screen = elements(hardware, "screen")[0]?.body ?? "";
    const diagonal = numberOrNull(text(screen, "diagonal-length"));
    const folded = elements(screen, "foldable-region")[0]?.body ?? null;
    const hingeBody = elements(hardware, "hinge")[0]?.body ?? null;
    const hinge = hingeBody
      ? Object.fromEntries([...hingeBody.matchAll(/<(?:[\w-]+:)?([\w-]+)>([^<]*)</gu)].map((match) => [match[1]!, decodeXml(match[2]!)]))
      : null;
    const tagId = text(body, "tag-id");
    const sensors = (text(hardware, "sensors") ?? "").split(/\s+/u).filter(Boolean);
    const cameras = elements(hardware, "camera").map((camera) => text(camera.body, "location"));
    const nav = text(hardware, "nav");
    const defaultState = elements(body, "state").find((state) => /default="true"/u.test(state.attrs)) ?? elements(body, "state")[0];
    const orientation = defaultState && text(defaultState.body, "screen-orientation") === "land" ? "landscape" : "portrait";
    const definition: AndroidDeviceDefinition = {
      profile: {
        id,
        name,
        origin: origin === "user" && id.startsWith("ade_") ? "ade" : origin,
        screenInches: diagonal,
        widthPx: numberOrNull(text(screen, "x-dimension")),
        heightPx: numberOrNull(text(screen, "y-dimension")),
        density: parseDensity(text(screen, "pixel-density")),
        formFactor: formFactor(tagId, Boolean(hinge), diagonal, text(screen, "screen-size")),
      },
      manufacturer: text(body, "manufacturer"),
      ramMb: parseMegabytes(elements(hardware, "ram")[0]),
      keyboard: text(hardware, "keyboard") === "qwerty",
      dpad: nav === "dpad",
      trackball: nav === "trackball",
      hardButtons: text(hardware, "buttons") === "hard",
      sensors,
      backCamera: cameras.includes("back"),
      frontCamera: cameras.includes("front"),
      mic: text(hardware, "mic") === "true",
      battery: (text(hardware, "power-type") ?? "battery") === "battery",
      playStore: text(body, "playstore-enabled") === "true",
      tagId,
      orientation,
      foldedRegion: folded
        ? {
          x: numberOrNull(text(folded, "x-folded-offset")) ?? 0,
          y: numberOrNull(text(folded, "y-folded-offset")) ?? 0,
          width: numberOrNull(text(folded, "x-folded-dimension")) ?? 0,
          height: numberOrNull(text(folded, "y-folded-dimension")) ?? 0,
        }
        : null,
      hinge,
    };
    definitions.push(definition);
  }
  return definitions;
}

/* ---------- where the profiles live ---------- */

/** Android Studio installs whose `sdklib.jar` also carries the device XML. */
function androidStudioSdklibJars(platform: NodeJS.Platform, env: AndroidEnv, home: string): string[] {
  const tail = path.join("plugins", "android", "lib", "sdklib.jar");
  if (platform === "darwin") {
    return [
      path.join("/Applications", "Android Studio.app", "Contents", tail),
      path.join(home, "Applications", "Android Studio.app", "Contents", tail),
    ];
  }
  if (platform === "win32") {
    return [
      path.join(env.ProgramFiles || "C:\\Program Files", "Android", "Android Studio", tail),
      path.join(env.LOCALAPPDATA || path.join(home, "AppData", "Local"), "Programs", "Android Studio", tail),
    ];
  }
  return [path.join("/opt", "android-studio", tail), path.join(home, "android-studio", tail)];
}

/** The SDK jars that may hold `com/android/sdklib/devices/*.xml`, best first. */
function androidSdklibJarCandidates(
  sdkRoot: string | null,
  options: { platform?: NodeJS.Platform; env?: AndroidEnv; home?: string } = {},
): string[] {
  const jars: string[] = [];
  const cmdline = sdkRoot ? androidCmdlineToolsDir(sdkRoot) : null;
  if (cmdline) {
    for (const dir of [path.join(cmdline, "lib", "sdklib"), path.join(cmdline, "lib")]) {
      try {
        for (const name of fs.readdirSync(dir).sort()) {
          if (/sdklib.*\.jar$/u.test(name)) jars.push(path.join(dir, name));
        }
      } catch {
        // No such folder in this cmdline-tools version.
      }
    }
  }
  jars.push(...androidStudioSdklibJars(options.platform ?? process.platform, options.env ?? process.env, options.home ?? os.homedir()));
  return jars;
}

type FileKey = { path: string; key: string };

function fileKey(filePath: string): FileKey | null {
  try {
    const stat = fs.statSync(filePath);
    return stat.isFile() ? { path: filePath, key: `${filePath}:${stat.mtimeMs}:${stat.size}` } : null;
  } catch {
    return null;
  }
}

const parsedCache = new Map<string, AndroidDeviceDefinition[]>();

function cachedParse(file: FileKey, read: () => AndroidDeviceDefinition[]): AndroidDeviceDefinition[] {
  const hit = parsedCache.get(file.key);
  if (hit) return hit;
  const parsed = read();
  for (const key of parsedCache.keys()) {
    if (key.startsWith(`${file.path}:`)) parsedCache.delete(key);
  }
  parsedCache.set(file.key, parsed);
  return parsed;
}

export type AndroidProfileListOptions = {
  sdkRoot: string | null;
  /** Installed system images; an image's own `devices.xml` (wear, tv) adds profiles. */
  systemImageDirs?: string[];
  platform?: NodeJS.Platform;
  env?: AndroidEnv;
  home?: string;
  /** A file that could not be read or parsed; the listing skips it. */
  onUnreadable?: (filePath: string, error: unknown) => void;
};

/**
 * Every hardware profile on this machine, by id. Later sources override
 * earlier ones (SDK, then system images, then the user's own), the order
 * Android Studio uses. Parsed once per file version.
 */
export function listAndroidDeviceDefinitions(options: AndroidProfileListOptions): AndroidDeviceDefinition[] {
  const env = options.env ?? process.env;
  const home = options.home ?? os.homedir();
  const byId = new Map<string, AndroidDeviceDefinition>();
  const add = (definitions: AndroidDeviceDefinition[]) => {
    for (const definition of definitions) byId.set(definition.profile.id, definition);
  };
  // One truncated jar or bad devices.xml must not hide every other profile.
  const parse = (file: FileKey, read: () => AndroidDeviceDefinition[]): AndroidDeviceDefinition[] => {
    try {
      return cachedParse(file, read);
    } catch (error) {
      options.onUnreadable?.(file.path, error);
      return [];
    }
  };

  for (const jar of androidSdklibJarCandidates(options.sdkRoot, { platform: options.platform, env, home })) {
    const file = fileKey(jar);
    if (!file) continue;
    const definitions = parse(file, () => {
      const entries = readZipTextEntries(jar, (name) => name.startsWith(SDKLIB_DEVICE_PREFIX) && name.endsWith(".xml"));
      return [...entries.keys()].sort().flatMap((name) => parseAndroidDeviceXml(entries.get(name)!, "sdk"));
    });
    if (definitions.length === 0) continue;
    add(definitions);
    break;
  }
  for (const dir of options.systemImageDirs ?? []) {
    const file = fileKey(path.join(dir, "devices.xml"));
    if (file) add(parse(file, () => parseAndroidDeviceXml(fs.readFileSync(file.path, "utf8"), "sdk")));
  }
  const userFile = fileKey(path.join(androidUserHome(env, home), "devices.xml"));
  if (userFile) add(parse(userFile, () => parseAndroidDeviceXml(fs.readFileSync(userFile.path, "utf8"), "user")));
  return [...byId.values()];
}

/* ---------- profile → config.ini ---------- */

const yesNo = (value: boolean): string => (value ? "yes" : "no");

/**
 * The hardware half of an AVD's `config.ini` for one profile: what
 * Android Studio writes, minus the skin (ADE runs headless) and the SD card
 * image (modern Android keeps `/sdcard` on the data partition).
 *
 * RAM is capped (2 GB by default, Studio's own default): a profile's
 * spec-sheet 8–12 GB would make every emulator cost that much of the host.
 */
export function androidHardwareConfig(
  definition: AndroidDeviceDefinition,
  options: { ramMb?: number; cpuCores?: number } = {},
): Record<string, string> {
  const { profile } = definition;
  const sensors = new Set(definition.sensors);
  const ramMb = options.ramMb ?? Math.min(definition.ramMb ?? 2048, 2048);
  const config: Record<string, string> = {
    "hw.device.name": profile.id,
    "hw.device.manufacturer": definition.manufacturer ?? "Generic",
    "hw.lcd.width": String(profile.widthPx ?? 1080),
    "hw.lcd.height": String(profile.heightPx ?? 2400),
    "hw.lcd.density": String(profile.density ?? 420),
    "hw.ramSize": String(ramMb),
    "hw.cpu.ncore": String(options.cpuCores ?? Math.max(1, Math.min(4, os.cpus().length))),
    "hw.keyboard": "yes",
    "hw.mainKeys": yesNo(definition.hardButtons),
    "hw.dPad": yesNo(definition.dpad),
    "hw.trackBall": yesNo(definition.trackball),
    "hw.accelerometer": yesNo(sensors.has("Accelerometer")),
    "hw.gyroscope": yesNo(sensors.has("Gyroscope")),
    "hw.gps": yesNo(sensors.has("GPS")),
    "hw.sensors.proximity": yesNo(sensors.has("ProximitySensor")),
    "hw.sensors.magnetic_field": yesNo(sensors.has("Compass")),
    "hw.sensors.orientation": yesNo(sensors.has("Accelerometer") && sensors.has("Compass")),
    "hw.sensors.pressure": yesNo(sensors.has("Barometer")),
    "hw.sensors.light": yesNo(sensors.has("LightSensor")),
    "hw.audioInput": yesNo(definition.mic),
    "hw.battery": yesNo(definition.battery),
    "hw.camera.back": definition.backCamera ? "virtualscene" : "none",
    "hw.camera.front": definition.frontCamera ? "emulated" : "none",
    "hw.initialOrientation": definition.orientation,
    "hw.gpu.enabled": "yes",
    "hw.gpu.mode": "auto",
    "hw.sdCard": "no",
    "disk.dataPartition.size": "6G",
    "runtime.network.latency": "none",
    "runtime.network.speed": "full",
    "showDeviceFrame": "no",
    "skin.dynamic": "yes",
  };
  const hinge = definition.hinge;
  if (hinge && definition.foldedRegion) {
    // The keys Android Studio writes for a foldable (read off a Studio-made
    // `pixel_9_pro_fold` AVD): the hinge, its postures, and the folded screen.
    const region = definition.foldedRegion;
    Object.assign(config, {
      "hw.sensor.hinge": "yes",
      "hw.sensor.hinge.count": hinge.count ?? "1",
      "hw.sensor.hinge.type": hinge.type ?? "1",
      "hw.sensor.hinge.sub_type": hinge["sub-type"] ?? "1",
      "hw.sensor.hinge.ranges": hinge.ranges ?? "0-180",
      "hw.sensor.hinge.defaults": hinge.defaults ?? "180",
      "hw.sensor.hinge.areas": hinge.areas ?? "",
      "hw.sensor.posture_list": hinge["posture-list"] ?? "",
      "hw.sensor.hinge_angles_posture_definitions": hinge["hinge-angles-posture-definitions"] ?? "",
      "hw.sensor.hinge.fold_to_displayRegion.0.1_at_posture": "1",
      "hw.displayRegion.0.1.xOffset": String(region.x),
      "hw.displayRegion.0.1.yOffset": String(region.y),
      "hw.displayRegion.0.1.width": String(region.width),
      "hw.displayRegion.0.1.height": String(region.height),
    });
  }
  return config;
}
