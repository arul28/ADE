import fs from "node:fs";
import path from "node:path";
import type { AndroidAdeProfileSpec, AndroidCatalogEntry } from "../../../shared/androidDeviceCatalog";
import { resolveAndroidCatalogProfile } from "../../../shared/androidDeviceCatalog";
import type { AndroidDeviceDefinition } from "./androidHardwareProfiles";

/*
 * The brand catalog in the brain (plan §7.1): which hardware profile a
 * catalog entry makes its AVD from, and the `ade_*` profiles ADE writes for
 * phones the SDK has no profile for.
 *
 * An `ade_*` profile is built in memory from the catalog's spec sheet, so a
 * create never depends on a file. ADE also adds it to the user's own
 * `<android user home>/devices.xml`, so Android Studio and the profile list
 * show it. That write is best effort and careful:
 * - The user's entries stay byte for byte. ADE adds or replaces only its own
 *   `<d:device>` blocks (id `ade_*`), and keeps the file's line endings.
 * - The write is atomic (a temp file in the same folder, then a rename).
 * - A file ADE cannot read as a device list is left as it is. The create
 *   still works, from the in-memory profile.
 * ADE never edits SDK files.
 */

/** The SDK profile a foldable `ade_*` profile copies its hinge from, newest first. */
const FOLD_TEMPLATE_PROFILE_IDS = ["pixel_10_pro_fold", "pixel_9_pro_fold", "pixel_fold"];

/** Studio's device schema namespace, for a `devices.xml` ADE makes from nothing. */
const DEVICES_XML_NAMESPACE = "http://schemas.android.com/sdk/devices/7";

/** Android's screen-size bucket for a diagonal, as Studio's device editor sets it. */
function screenSizeBucket(diagonalInches: number): string {
  if (diagonalInches >= 7) return "xlarge";
  if (diagonalInches >= 4.4) return "normal";
  return "small";
}

/**
 * The definition an `ade_*` profile stands for. A foldable copies the hinge
 * of this SDK's Pixel Fold profile (the emulator's own posture keys), scaled
 * to the catalog phone's inner screen; with no such profile on this SDK it
 * is made as a large phone with no hinge.
 */
export function androidAdeProfileDefinition(
  spec: AndroidAdeProfileSpec,
  sdkDefinitions: readonly AndroidDeviceDefinition[] = [],
): AndroidDeviceDefinition {
  const foldTemplate = spec.folded
    ? FOLD_TEMPLATE_PROFILE_IDS.map((id) => sdkDefinitions.find((entry) => entry.profile.id === id)).find((entry) => entry?.hinge) ?? null
    : null;
  const hinge = foldTemplate?.hinge ? { ...foldTemplate.hinge } : null;
  if (hinge?.areas && /^\d+-\d+-\d+-\d+$/u.test(hinge.areas)) {
    // `x-y-width-height` of the hinge on the inner screen: down the middle.
    const [, , width] = hinge.areas.split("-").map(Number);
    hinge.areas = `${Math.round(spec.widthPx / 2)}-0-${width}-${spec.heightPx}`;
  }
  const folded = hinge && spec.folded
    ? {
      // The cover screen sits on the right half of the inner one, as on the Pixel Fold profiles.
      x: Math.max(0, spec.widthPx - spec.folded.widthPx),
      y: 0,
      width: Math.min(spec.folded.widthPx, spec.widthPx),
      height: Math.min(spec.folded.heightPx, spec.heightPx),
    }
    : null;
  return {
    profile: {
      id: spec.id,
      name: spec.name,
      origin: "ade",
      screenInches: spec.diagonalInches,
      widthPx: spec.widthPx,
      heightPx: spec.heightPx,
      density: spec.density,
      formFactor: hinge ? "foldable" : spec.diagonalInches >= 7 ? "tablet" : "phone",
    },
    manufacturer: spec.manufacturer,
    ramMb: spec.ramMb,
    keyboard: false,
    dpad: false,
    trackball: false,
    hardButtons: false,
    sensors: ["Accelerometer", "Barometer", "Compass", "GPS", "Gyroscope", "LightSensor", "ProximitySensor"],
    backCamera: true,
    frontCamera: true,
    mic: true,
    battery: true,
    playStore: true,
    tagId: null,
    orientation: "portrait",
    foldedRegion: folded,
    hinge,
  };
}

export type AndroidCatalogProfileChoice = {
  definition: AndroidDeviceDefinition;
  /** True when the entry's own (newest) SDK profile is missing and an older one stands in. */
  fallback: boolean;
};

/**
 * The definition a catalog entry makes its AVD from on this machine: its
 * `ade_*` profile, or the first of its Pixel ids this SDK has. Null when the
 * SDK has none of them (an SDK with no Pixel profiles at all).
 */
export function resolveAndroidCatalogDefinition(
  entry: AndroidCatalogEntry,
  definitions: readonly AndroidDeviceDefinition[],
): AndroidCatalogProfileChoice | null {
  if (entry.adeProfile) {
    return { definition: androidAdeProfileDefinition(entry.adeProfile, definitions), fallback: false };
  }
  const choice = resolveAndroidCatalogProfile(entry, definitions.map((definition) => definition.profile.id));
  if (!choice) return null;
  const definition = definitions.find((entry) => entry.profile.id === choice.profileId);
  return definition ? { definition, fallback: choice.fallback } : null;
}

/* ---------- devices.xml ---------- */

function escapeXml(value: string): string {
  return value
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;");
}

/**
 * The schema's `pixel-density` value for a dpi. The device schema allows only
 * an enumerated set (`devices-7.xsd`: `420dpi`, `560dpi`, `xxhdpi`, …), and
 * avdmanager rejects a file with any other value, so a dpi off the list is
 * written as the nearest value on it.
 */
const SCHEMA_DENSITIES: ReadonlyArray<[number, string]> = [
  [120, "ldpi"], [140, "140dpi"], [160, "mdpi"], [180, "180dpi"], [200, "200dpi"], [213, "tvdpi"],
  [240, "hdpi"], [260, "260dpi"], [280, "280dpi"], [300, "300dpi"], [320, "xhdpi"], [340, "340dpi"],
  [360, "360dpi"], [400, "400dpi"], [420, "420dpi"], [440, "440dpi"], [480, "xxhdpi"], [560, "560dpi"],
  [640, "xxxhdpi"],
];

export function androidDensityToken(dpi: number): string {
  let best = SCHEMA_DENSITIES[0]!;
  for (const entry of SCHEMA_DENSITIES) {
    if (Math.abs(entry[0] - dpi) < Math.abs(best[0] - dpi)) best = entry;
  }
  return best[1];
}

/**
 * One `<d:device>` block in Studio's device schema, element order as the
 * schema wants it. A foldable's hinge is not written here (its schema
 * elements differ between Studio versions); the AVD's `config.ini` carries
 * the hinge, so the emulator still folds.
 */
export function androidAdeDeviceXml(spec: AndroidAdeProfileSpec, prefix: string, indent: string, eol: string): string {
  const p = prefix ? `${prefix}:` : "";
  const xdpi = Math.hypot(spec.widthPx, spec.heightPx) / spec.diagonalInches;
  const long = Math.max(spec.widthPx, spec.heightPx);
  const short = Math.min(spec.widthPx, spec.heightPx);
  const ratio = long / short > 1.7 ? "long" : "notlong";
  const i1 = indent;
  const i2 = indent.repeat(2);
  const i3 = indent.repeat(3);
  const i4 = indent.repeat(4);
  const lines = [
    `${i1}<${p}device>`,
    `${i2}<${p}name>${escapeXml(spec.name)}</${p}name>`,
    `${i2}<${p}id>${escapeXml(spec.id)}</${p}id>`,
    `${i2}<${p}manufacturer>${escapeXml(spec.manufacturer)}</${p}manufacturer>`,
    `${i2}<${p}hardware>`,
    `${i3}<${p}screen>`,
    `${i4}<${p}screen-size>${screenSizeBucket(spec.diagonalInches)}</${p}screen-size>`,
    `${i4}<${p}diagonal-length>${spec.diagonalInches}</${p}diagonal-length>`,
    `${i4}<${p}pixel-density>${androidDensityToken(spec.density)}</${p}pixel-density>`,
    `${i4}<${p}screen-ratio>${ratio}</${p}screen-ratio>`,
    `${i4}<${p}dimensions>`,
    `${i4}${indent}<${p}x-dimension>${spec.widthPx}</${p}x-dimension>`,
    `${i4}${indent}<${p}y-dimension>${spec.heightPx}</${p}y-dimension>`,
    `${i4}</${p}dimensions>`,
    `${i4}<${p}xdpi>${xdpi.toFixed(2)}</${p}xdpi>`,
    `${i4}<${p}ydpi>${xdpi.toFixed(2)}</${p}ydpi>`,
    `${i4}<${p}touch>`,
    `${i4}${indent}<${p}multitouch>jazz-hands</${p}multitouch>`,
    `${i4}${indent}<${p}mechanism>finger</${p}mechanism>`,
    `${i4}${indent}<${p}screen-type>capacitive</${p}screen-type>`,
    `${i4}</${p}touch>`,
    `${i3}</${p}screen>`,
    `${i3}<${p}networking>`,
    `${i4}Bluetooth${eol}${i4}Wifi${eol}${i4}NFC`,
    `${i3}</${p}networking>`,
    `${i3}<${p}sensors>`,
    `${i4}Accelerometer${eol}${i4}Barometer${eol}${i4}Compass${eol}${i4}GPS${eol}${i4}Gyroscope${eol}${i4}LightSensor${eol}${i4}ProximitySensor`,
    `${i3}</${p}sensors>`,
    `${i3}<${p}mic>true</${p}mic>`,
    `${i3}<${p}camera>`,
    `${i4}<${p}location>back</${p}location>`,
    `${i4}<${p}autofocus>true</${p}autofocus>`,
    `${i4}<${p}flash>true</${p}flash>`,
    `${i3}</${p}camera>`,
    `${i3}<${p}camera>`,
    `${i4}<${p}location>front</${p}location>`,
    `${i4}<${p}autofocus>false</${p}autofocus>`,
    `${i4}<${p}flash>false</${p}flash>`,
    `${i3}</${p}camera>`,
    `${i3}<${p}keyboard>nokeys</${p}keyboard>`,
    `${i3}<${p}nav>nonav</${p}nav>`,
    `${i3}<${p}ram unit="MiB">${spec.ramMb}</${p}ram>`,
    `${i3}<${p}buttons>soft</${p}buttons>`,
    `${i3}<${p}internal-storage unit="GiB">${eol}${i4}128${eol}${i3}</${p}internal-storage>`,
    `${i3}<${p}removable-storage unit="TiB"></${p}removable-storage>`,
    `${i3}<${p}cpu>Generic CPU</${p}cpu>`,
    `${i3}<${p}gpu>Generic GPU</${p}gpu>`,
    `${i3}<${p}abi>${eol}${i4}arm64-v8a${eol}${i4}x86_64${eol}${i3}</${p}abi>`,
    `${i3}<${p}dock></${p}dock>`,
    `${i3}<${p}power-type>battery</${p}power-type>`,
    `${i2}</${p}hardware>`,
    `${i2}<${p}software>`,
    `${i3}<${p}api-level>-</${p}api-level>`,
    `${i3}<${p}live-wallpaper-support>true</${p}live-wallpaper-support>`,
    `${i3}<${p}bluetooth-profiles></${p}bluetooth-profiles>`,
    `${i3}<${p}gl-version>2.0</${p}gl-version>`,
    `${i3}<${p}gl-extensions></${p}gl-extensions>`,
    `${i3}<${p}status-bar>true</${p}status-bar>`,
    `${i2}</${p}software>`,
    `${i2}<${p}state default="true" name="Portrait">`,
    `${i3}<${p}description>The device in portrait orientation</${p}description>`,
    `${i3}<${p}screen-orientation>port</${p}screen-orientation>`,
    `${i3}<${p}keyboard-state>keyssoft</${p}keyboard-state>`,
    `${i3}<${p}nav-state>nonav</${p}nav-state>`,
    `${i2}</${p}state>`,
    `${i2}<${p}state name="Landscape">`,
    `${i3}<${p}description>The device in landscape orientation</${p}description>`,
    `${i3}<${p}screen-orientation>land</${p}screen-orientation>`,
    `${i3}<${p}keyboard-state>keyssoft</${p}keyboard-state>`,
    `${i3}<${p}nav-state>nonav</${p}nav-state>`,
    `${i2}</${p}state>`,
    `${i1}</${p}device>`,
  ];
  return lines.join(eol);
}

export type AndroidDevicesXmlMerge =
  | { kind: "unchanged"; text: string }
  | { kind: "changed"; text: string }
  /** Not a device list ADE can add to: leave the file alone. */
  | { kind: "unreadable"; reason: string };

/**
 * The user's `devices.xml` text with ADE's profile added, or its own old
 * block for the same id replaced. Every other byte stays as it was.
 */
export function mergeAndroidDevicesXml(existing: string | null, spec: AndroidAdeProfileSpec): AndroidDevicesXmlMerge {
  if (existing === null || existing.trim() === "") {
    const block = androidAdeDeviceXml(spec, "d", "  ", "\n");
    const text = [
      "<?xml version=\"1.0\" encoding=\"utf-8\"?>",
      `<d:devices xmlns:d="${DEVICES_XML_NAMESPACE}" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">`,
      block,
      "</d:devices>",
      "",
    ].join("\n");
    return { kind: "changed", text };
  }
  const root = /<(?:([\w-]+):)?devices(\s[^>]*)?>/u.exec(existing);
  if (!root) return { kind: "unreadable", reason: "no <devices> root element" };
  const prefix = root[1] ?? "";
  const p = prefix ? `${prefix}:` : "";
  const closeTag = `</${p}devices>`;
  const closeAt = existing.lastIndexOf(closeTag);
  if (closeAt < 0 || closeAt < root.index) return { kind: "unreadable", reason: `no ${closeTag}` };
  const eol = existing.includes("\r\n") ? "\r\n" : "\n";
  const indent = /\n([ \t]+)<(?:[\w-]+:)?device[\s>]/u.exec(existing)?.[1] ?? "  ";
  const block = androidAdeDeviceXml(spec, prefix, indent, eol);
  // An earlier block of ours for the same id is replaced, not duplicated.
  const escapedP = p.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const devicePattern = new RegExp(`([ \\t]*)<${escapedP}device(?:\\s[^>]*)?>[\\s\\S]*?</${escapedP}device>`, "gu");
  for (const match of existing.matchAll(devicePattern)) {
    const idMatch = new RegExp(`<${escapedP}id>\\s*([^<]*?)\\s*</${escapedP}id>`, "u").exec(match[0]);
    if (idMatch?.[1] !== spec.id) continue;
    const start = match.index;
    const end = start + match[0].length;
    if (existing.slice(start, end) === block) return { kind: "unchanged", text: existing };
    return { kind: "changed", text: `${existing.slice(0, start)}${block}${existing.slice(end)}` };
  }
  // Before the closing tag, on its own line.
  const before = existing.slice(0, closeAt);
  const lineStart = before.lastIndexOf("\n") + 1;
  const onOwnLine = before.slice(lineStart).trim() === "";
  const insertAt = onOwnLine ? lineStart : closeAt;
  const lead = onOwnLine ? "" : eol;
  return { kind: "changed", text: `${existing.slice(0, insertAt)}${lead}${block}${eol}${existing.slice(insertAt)}` };
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Adds ADE's profile to `<userHome>/devices.xml`. Atomic: a temp file in the
 * same folder, then a rename, so a crash leaves the old file or the new one,
 * never half of one. On Windows the rename fails while another program holds
 * the file open; it is tried a few times, then given up (the create does not
 * need the file). Returns why it did not write, or null when the file holds
 * the profile.
 */
export function writeAndroidAdeProfile(userHome: string, spec: AndroidAdeProfileSpec): string | null {
  const filePath = path.join(userHome, "devices.xml");
  let existing: string | null = null;
  try {
    existing = fs.readFileSync(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") return `could not read ${filePath}: ${(error as Error).message}`;
  }
  const merged = mergeAndroidDevicesXml(existing, spec);
  if (merged.kind === "unreadable") return `${filePath} is not a device list ADE can add to (${merged.reason}); it was left as it is`;
  if (merged.kind === "unchanged") return null;
  fs.mkdirSync(userHome, { recursive: true });
  const temp = `${filePath}.ade-${process.pid}-${Date.now()}.tmp`;
  try {
    fs.writeFileSync(temp, merged.text, "utf8");
    for (let attempt = 0; ; attempt += 1) {
      try {
        fs.renameSync(temp, filePath);
        return null;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (attempt >= 4 || (code !== "EPERM" && code !== "EBUSY" && code !== "EACCES")) throw error;
        sleepSync(100 * (attempt + 1));
      }
    }
  } catch (error) {
    fs.rmSync(temp, { force: true });
    return `could not write ${filePath}: ${(error as Error).message}`;
  }
}
