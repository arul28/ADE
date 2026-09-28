import os from "node:os";
import path from "node:path";
import type {
  AppleInstalledRuntime,
  AppleInstalledSimulator,
  AppleLaneDeviceFamily,
  AppleSimulatorDeviceType,
} from "../../../shared/types/iosSimulator";
import { AppleNoInstalledSimulatorsError, AppleRuntimeNotInstalledError } from "./appleDeviceErrors";

/**
 * What `simctl` says this Mac has: runtimes, the device types each one runs,
 * and the device set. Pure parsing and picking, so every caller reads
 * `simctl` output the same way and the precedence is testable without a Mac.
 */

/** Where CoreSimulator keeps one directory per simulator, all of its data in it. */
export function appleDeviceDataRoot(home = os.homedir()): string {
  return path.join(home, "Library", "Developer", "CoreSimulator", "Devices");
}

/**
 * Which family a simulator belongs to.
 *
 * Read off the device-type identifier first and the name second: a user can
 * rename a simulator to anything, and "iPad" in a custom name is not evidence.
 */
export function appleDeviceFamily(input: { deviceTypeIdentifier?: string | null; name?: string | null }): AppleLaneDeviceFamily {
  const haystack = `${input.deviceTypeIdentifier ?? ""} ${input.name ?? ""}`;
  if (/ipad/i.test(haystack)) return "ipad";
  if (/watch/i.test(haystack)) return "watch";
  return "iphone";
}

/** Sorts a runtime string so "iOS 26.1" beats "iOS 18.4" numerically, not lexically. */
export function appleRuntimeScore(runtime: string): number {
  const match = /(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(runtime);
  if (!match) return 0;
  return (Number(match[1]) * 1_000_000) + (Number(match[2] ?? 0) * 1_000) + Number(match[3] ?? 0);
}

/** `com.apple.CoreSimulator.SimRuntime.iOS-26-3` → `iOS 26.3`, and the same for watchOS, tvOS, xrOS. */
function appleRuntimeName(runtimeKey: string): string {
  const tail = runtimeKey.split(".").pop() ?? runtimeKey;
  const match = /^([A-Za-z]+)-(.+)$/u.exec(tail);
  return match ? `${match[1]} ${match[2]!.replace(/-/g, ".")}` : tail;
}

export type SimctlListedDevice = {
  udid: string;
  name: string;
  state: string;
  runtime: string;
  isAvailable: boolean;
  deviceTypeIdentifier: string | null;
};

type SimctlListDevicesJson = {
  devices?: Record<string, Array<{
    udid?: string;
    name?: string;
    state?: string;
    isAvailable?: boolean;
    availabilityError?: string;
    deviceTypeIdentifier?: unknown;
  }>>;
};

/**
 * `simctl list devices [available] --json`, every device by udid.
 *
 * Throws when the output has no device set at all, so a caller that deletes
 * on "not listed" never acts on an empty answer it could not read.
 */
export function parseSimctlDevices(stdout: string): Map<string, SimctlListedDevice> {
  const parsed = JSON.parse(stdout) as SimctlListDevicesJson;
  if (!parsed || typeof parsed.devices !== "object" || parsed.devices === null) {
    throw new Error("simctl list devices returned no device set");
  }
  const all = new Map<string, SimctlListedDevice>();
  for (const [runtimeKey, devices] of Object.entries(parsed.devices)) {
    const runtime = appleRuntimeName(runtimeKey);
    for (const device of devices ?? []) {
      if (!device.udid) continue;
      all.set(device.udid, {
        udid: device.udid,
        name: device.name ?? device.udid,
        state: device.state ?? "Unknown",
        runtime,
        isAvailable: device.isAvailable !== false && !device.availabilityError,
        deviceTypeIdentifier: typeof device.deviceTypeIdentifier === "string" ? device.deviceTypeIdentifier : null,
      });
    }
  }
  return all;
}

/** The installed, available simulators in `simctl list devices` output, for the picker. */
export function appleInstalledSimulatorsFrom(devices: Map<string, SimctlListedDevice>): AppleInstalledSimulator[] {
  const installed: AppleInstalledSimulator[] = [];
  for (const device of devices.values()) {
    if (!device.isAvailable || !device.name) continue;
    installed.push({
      udid: device.udid,
      name: device.name,
      runtime: device.runtime,
      state: device.state,
      isAvailable: true,
      family: appleDeviceFamily({ deviceTypeIdentifier: device.deviceTypeIdentifier, name: device.name }),
      deviceTypeIdentifier: device.deviceTypeIdentifier,
    });
  }
  return installed;
}

type SimctlRuntimesJson = {
  runtimes?: Array<{
    identifier?: string;
    name?: string;
    version?: string;
    platform?: string;
    isAvailable?: boolean;
    supportedDeviceTypes?: Array<{ identifier?: string; name?: string; productFamily?: string }>;
  }>;
};

/** `simctl list runtimes available --json` into the installed runtimes, iOS first and newest first. */
export function parseAppleInstalledRuntimes(stdout: string): AppleInstalledRuntime[] {
  const parsed = JSON.parse(stdout) as SimctlRuntimesJson;
  const runtimes: AppleInstalledRuntime[] = [];
  for (const runtime of parsed.runtimes ?? []) {
    if (!runtime.identifier || !runtime.name || runtime.isAvailable === false) continue;
    const deviceTypes: AppleSimulatorDeviceType[] = [];
    for (const type of runtime.supportedDeviceTypes ?? []) {
      if (!type.identifier || !type.name) continue;
      deviceTypes.push({
        identifier: type.identifier,
        name: type.name,
        family: appleDeviceFamily({ deviceTypeIdentifier: type.identifier, name: `${type.productFamily ?? ""} ${type.name}` }),
      });
    }
    runtimes.push({
      identifier: runtime.identifier,
      name: runtime.name,
      version: runtime.version ?? "",
      platform: runtime.platform ?? runtime.name.split(" ")[0] ?? "",
      deviceTypes,
    });
  }
  return runtimes.sort((a, b) => {
    const byPlatform = Number(b.platform === "iOS") - Number(a.platform === "iOS");
    if (byPlatform !== 0) return byPlatform;
    return appleRuntimeScore(b.version || b.name) - appleRuntimeScore(a.version || a.name);
  });
}

const matchesName = (value: string, wanted: string): boolean =>
  value === wanted || value.toLowerCase() === wanted.toLowerCase();

/**
 * Does `wanted` name this simulator? The udid first, then the exact name,
 * then the name ignoring case — the one precedence every attach, detach and
 * "is this my device" check uses.
 */
export function matchesSimulatorName(device: { udid: string; name: string }, wanted: string): boolean {
  const trimmed = wanted.trim();
  if (!trimmed) return false;
  return device.udid === trimmed || matchesName(device.name, trimmed);
}

/**
 * The runtime and device type a new lane device is made from.
 *
 * Order: an explicit `runtime`/`deviceType`, then `from` (an installed
 * simulator whose model and runtime to copy — never its data), then the newest
 * installed iOS runtime with the device type this project used last, else the
 * first iPhone that runtime lists (CoreSimulator lists the newest first).
 */
export function pickAppleDeviceSpec(input: {
  runtimes: AppleInstalledRuntime[];
  installed?: AppleInstalledSimulator[];
  runtime?: string | null;
  deviceType?: string | null;
  from?: string | null;
  lastDeviceType?: string | null;
}): { runtime: AppleInstalledRuntime; deviceType: AppleSimulatorDeviceType } {
  const runtimes = input.runtimes.filter((runtime) => runtime.deviceTypes.length > 0);
  if (!runtimes.length) throw new AppleNoInstalledSimulatorsError();
  const runtimeNames = runtimes.map((runtime) => runtime.name);
  let wantedRuntime = input.runtime?.trim() || null;
  let wantedType = input.deviceType?.trim() || null;
  const from = input.from?.trim();
  if (from) {
    const installed = input.installed ?? [];
    const source = installed.find((device) => device.udid === from)
      ?? installed.find((device) => matchesSimulatorName(device, from));
    if (!source) {
      throw new Error(`No installed simulator matches ${from}. Run device-list --installed to see what this Mac has.`);
    }
    wantedRuntime ??= source.runtime;
    wantedType ??= source.deviceTypeIdentifier;
  }
  const runtime = wantedRuntime
    ? runtimes.find((candidate) => candidate.identifier === wantedRuntime
      || matchesName(candidate.name, wantedRuntime)
      || candidate.version === wantedRuntime)
    : runtimes.find((candidate) => candidate.platform === "iOS");
  if (!wantedRuntime && !runtime) throw new AppleNoInstalledSimulatorsError();
  if (!runtime) throw new AppleRuntimeNotInstalledError(`Runtime ${wantedRuntime}`, runtimeNames);
  const findType = (wanted: string) => runtime.deviceTypes.find((type) => type.identifier === wanted || matchesName(type.name, wanted));
  if (wantedType) {
    const type = findType(wantedType);
    if (!type) {
      throw new AppleRuntimeNotInstalledError(
        `Device type ${wantedType} on ${runtime.name}`,
        runtime.deviceTypes.slice(0, 8).map((candidate) => candidate.name),
      );
    }
    return { runtime, deviceType: type };
  }
  const last = input.lastDeviceType?.trim();
  const remembered = last ? findType(last) : undefined;
  const deviceType = remembered
    ?? runtime.deviceTypes.find((type) => type.family === "iphone")
    ?? runtime.deviceTypes[0]!;
  return { runtime, deviceType };
}

/**
 * `du -d 1 -k <root>` into per-device bytes plus the store's own total.
 *
 * ONE depth-1 pass answers both halves of the question the picker asks, which
 * is why it is `-d 1` on the store rather than a `-s` per device: the store is
 * tens of gigabytes and the owner who asked for this is at 15 GB free, so the
 * measurement must not itself be the expensive thing. `du` prints children
 * first and the argument last, so the line whose path IS the root is the
 * total; on a machine where that line never arrives the sum of the children is
 * the honest floor.
 *
 * Sizes are `-k`, so KiB. A child whose basename is not a udid-shaped
 * directory (`.DS_Store`, a stray file) counts toward the total and produces
 * no row, which is exactly what "total device data" should mean.
 */
export function parseAppleDeviceDiskUsage(input: {
  stdout: string;
  root: string;
}): { totalBytes: number; devices: Array<{ udid: string; bytes: number }> } {
  const root = input.root.replace(/\/+$/u, "");
  const devices: Array<{ udid: string; bytes: number }> = [];
  let total: number | null = null;
  let sum = 0;
  for (const line of input.stdout.split("\n")) {
    const match = /^(\d+)\s+(.*\S)\s*$/u.exec(line);
    if (!match) continue;
    const bytes = Number(match[1]) * 1024;
    const target = match[2]!.replace(/\/+$/u, "");
    if (target === root) {
      total = bytes;
      continue;
    }
    if (path.dirname(target) !== root) continue;
    sum += bytes;
    const udid = path.basename(target);
    // CoreSimulator names each directory for the udid. Anything else in the
    // store is real disk use with no device to attribute it to.
    if (/^[0-9A-F-]{20,}$/iu.test(udid)) devices.push({ udid, bytes });
  }
  return { totalBytes: total ?? sum, devices };
}
