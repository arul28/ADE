import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { appleRecordingsDirectory } from "./recording/appleRecordingsStore";
import { bareSimulatorPowerOff } from "./simulatorPower";

import type {
  AppleDeviceCleanupResult,
  AppleDeviceDiskUsage,
  AppleDeviceListResult,
  AppleInstalledRuntime,
  AppleInstalledSimulator,
  AppleLaneDevice,
  AppleLaneDeviceFamily,
  AppleLaneDeviceOrigin,
  AppleSimulatorDeviceType,
  AppleSimulatorOwner,
  AppleSimulatorOwnershipInfo,
} from "../../../shared/types/iosSimulator";
import {
  APPLE_DEVICE_ATTACHED_NOT_DELETABLE_CODE,
  APPLE_DEVICE_EXISTS_CODE,
  APPLE_DEVICE_NOT_LANE_OWNED_CODE,
  APPLE_DEVICE_OWNED_BY_LANE_CODE,
  APPLE_NO_INSTALLED_SIMULATORS_CODE,
  APPLE_RUNTIME_NOT_INSTALLED_CODE,
  isAdeOwnedLaneDevice,
} from "../../../shared/types/iosSimulator";

/**
 * One simulator per lane, many per machine.
 *
 * A lane gets no device until it is asked for. The first ask makes a NEW,
 * empty device (`simctl create`) from an installed runtime and names it for
 * the lane, so two lanes never share a screen or each other's app data, and a
 * lane's device is recognisable in Xcode's own device list. Nothing is copied:
 * each lane builds and installs its own version of the app anyway, and a copy
 * of another device only carried that device's gigabytes of data and state.
 *
 * ADE writes a marker file into every device it makes (`appleDeviceMarkerPath`).
 * The marker, not only the database row, is what proves a device is ADE's: a
 * row can be lost, and without the marker a leaked device looks exactly like
 * the user's own and is kept forever. The cleanup pass (`reconcile`) deletes a
 * marked device that no live lane holds.
 *
 * A lane may instead ATTACH an existing simulator, which binds without making
 * one — and which is why delete has two behaviours: ADE deletes what it
 * created and never deletes what it did not.
 *
 * ADE never downloads a runtime. `simctl` will happily fetch several gigabytes
 * for a runtime that is merely *known*; a lane asking for a device must not
 * start that, so every runtime comes from the installed list and an empty list
 * is a refusal (`APPLE_NO_INSTALLED_SIMULATORS`) rather than a download.
 */

export class AppleNoInstalledSimulatorsError extends Error {
  readonly code = APPLE_NO_INSTALLED_SIMULATORS_CODE;

  constructor() {
    super(`${APPLE_NO_INSTALLED_SIMULATORS_CODE}: no iOS Simulator runtime is installed, and ADE never downloads one. Install one from Xcode ▸ Settings ▸ Components, then ask again.`);
    this.name = "AppleNoInstalledSimulatorsError";
  }
}

export class AppleDeviceExistsError extends Error {
  readonly code = APPLE_DEVICE_EXISTS_CODE;

  constructor(readonly device: AppleLaneDevice) {
    super(`${APPLE_DEVICE_EXISTS_CODE}: lane ${device.laneId} already has ${device.name} (${device.udid}). Delete it first to create another.`);
    this.name = "AppleDeviceExistsError";
  }
}

export class AppleDeviceAttachedNotDeletableError extends Error {
  readonly code = APPLE_DEVICE_ATTACHED_NOT_DELETABLE_CODE;

  constructor(readonly device: AppleLaneDevice) {
    super(`${APPLE_DEVICE_ATTACHED_NOT_DELETABLE_CODE}: ${device.name} was attached, not created by ADE, so ADE will not delete it. Pass force to detach it from lane ${device.laneId} instead.`);
    this.name = "AppleDeviceAttachedNotDeletableError";
  }
}

export class AppleDeviceOwnedByLaneError extends Error {
  readonly code = APPLE_DEVICE_OWNED_BY_LANE_CODE;

  constructor(readonly device: AppleLaneDevice) {
    super(`${APPLE_DEVICE_OWNED_BY_LANE_CODE}: ${device.name} (${device.udid}) is held by lane ${device.laneId}. That lane gives it up itself; deleting it here would take its live view away with no warning on its screen.`);
    this.name = "AppleDeviceOwnedByLaneError";
  }
}

/** How the refused simulator is in use, which decides the refusal's reason. */
export type AppleDeviceNotLaneOwnedReason =
  | { kind: "other-lane"; laneLabel: string }
  | { kind: "running" }
  | { kind: "not-created" };

/**
 * An agent asked for a simulator its lane may not use.
 *
 * An agent may attach an installed simulator no lane holds (the user named it),
 * but never one another lane holds. For every other verb it drives only its
 * lane's own device, so a foreign udid is refused and the refusal points at
 * attaching it or at making the lane's own device.
 */
export class AppleDeviceNotLaneOwnedError extends Error {
  readonly code = APPLE_DEVICE_NOT_LANE_OWNED_CODE;

  constructor(readonly simulator: { udid: string; name: string }, readonly reason: AppleDeviceNotLaneOwnedReason) {
    const why = reason.kind === "other-lane"
      ? `belongs to lane ${reason.laneLabel}`
      : reason.kind === "running"
        ? "is not this lane's device and it is already running; another lane, a test run or the user may be using it"
        : "is not this lane's device";
    const next = reason.kind === "other-lane"
      ? "Use this lane's own device: `ade apple device-create` makes one."
      : "If the user named it, attach it first with `ade apple device-attach --simulator <udid>`; "
        + "otherwise use this lane's own device (`ade apple device-create` makes one).";
    super(`${APPLE_DEVICE_NOT_LANE_OWNED_CODE}: Simulator ${simulator.name} (${simulator.udid}) ${why}. ${next}`);
    this.name = "AppleDeviceNotLaneOwnedError";
  }
}

export class AppleRuntimeNotInstalledError extends Error {
  readonly code = APPLE_RUNTIME_NOT_INSTALLED_CODE;

  constructor(what: string, installed: string[]) {
    super(
      `${APPLE_RUNTIME_NOT_INSTALLED_CODE}: ${what} is not installed on this Mac, and ADE never downloads one. `
        + (installed.length ? `Installed: ${installed.join(", ")}.` : "Install one from Xcode ▸ Settings ▸ Components."),
    );
    this.name = "AppleRuntimeNotInstalledError";
  }
}

export const LANE_APPLE_DEVICES_TABLE = "lane_apple_devices" as const;
/** KV key holding the device type this project made its last lane device from. */
export const APPLE_LAST_DEVICE_TYPE_KEY = "apple:last-device-type" as const;
/**
 * KV key: udid → bundle ids ADE installed on an ATTACHED device.
 *
 * An attached device is the user's, so ADE never deletes it. What ADE put on
 * it is ADE's, and that is where the disk goes (app data, not iOS), so it is
 * uninstalled when the lane lets the device go.
 */
export const APPLE_ADE_INSTALLED_APPS_KEY = "apple:ade-installed-apps" as const;
/** The file ADE writes into each device directory it creates. */
export const APPLE_DEVICE_MARKER_FILE = "ade-lane-device.json" as const;
/**
 * A marked device younger than this is never deleted by the cleanup pass. The
 * marker is written before the lane row, so a create in flight has a marker and
 * no row for a moment.
 */
const MARKER_GRACE_MS = 5 * 60_000;
/** See `endLaneDeviceOnDisk`: the wait between the last uninstall and the power-off. */
const UNINSTALL_SETTLE_MS = 5_000;

type RunCommand = (
  command: string,
  args: string[],
  options?: { cwd?: string; timeoutMs?: number; env?: NodeJS.ProcessEnv },
) => Promise<{ stdout: string; stderr: string }>;

/** The slice of `AdeDb` this registry needs. Narrow so tests need no database. */
export type LaneDeviceStore = {
  run: (sql: string, params?: Array<string | number | null>) => void;
  get: <T extends Record<string, unknown> = Record<string, unknown>>(sql: string, params?: Array<string | number | null>) => T | null;
  all: <T extends Record<string, unknown> = Record<string, unknown>>(sql: string, params?: Array<string | number | null>) => T[];
  getJson: <T = unknown>(key: string) => T | null;
  setJson: (key: string, value: unknown) => void;
};

export type LaneDeviceRegistryDeps = {
  run: RunCommand;
  /**
   * Power a device off before `simctl delete`, which on a booted device leaves
   * CoreSimulator holding the data directory and reports success having
   * removed nothing. The host's `simulatorPower`, so the recording, the helper
   * session and the device list hear it. May throw; the delete goes ahead.
   */
  powerOffDevice: (udid: string) => Promise<unknown>;
  /** Every installed, available simulator on this Mac. */
  listInstalledSimulators: () => Promise<AppleInstalledSimulator[]>;
  /**
   * Every installed runtime and the device types it runs. Defaults to
   * `simctl list runtimes available --json`.
   */
  listInstalledRuntimes?: (() => Promise<AppleInstalledRuntime[]>) | null;
  /**
   * The project this registry serves. Written into each device's marker, and
   * the cleanup pass only deletes marked devices of this project (or of a
   * project that no longer exists on disk).
   */
  projectRoot?: string | null;
  /**
   * Stop every stream, hub session and recording that reads this device,
   * before the cleanup pass powers it off or deletes it. The host's; optional.
   */
  releaseDeviceHolds?: ((udid: string) => Promise<void>) | null;
  /** Human name for a lane, used in the clone's name. Null falls back to the id. */
  resolveLaneName?: ((laneId: string) => string | null) | null;
  /** The lanes DB. Omitted in hosts that have none; the registry then keeps rows in memory. */
  store?: LaneDeviceStore | null;
  /**
   * Let go of a device a lane is about to LOSE to a takeover.
   *
   * The registry owns the binding and knows nothing about streams or chat
   * sessions, so the host hands in the release. Called with the losing lane's
   * device, before the binding moves, and allowed to fail: the move is what
   * must not be left half-done.
   */
  releaseLaneDevice?: ((device: AppleLaneDevice) => Promise<void> | void) | null;
  /**
   * CoreSimulator's device store. Defaults to the real one under `$HOME`.
   *
   * Injectable so the disk measurement is testable without a Mac and without
   * the test's answer depending on whose machine ran it.
   */
  deviceDataRoot?: string | null;
  logger: {
    info: (event: string, data?: Record<string, unknown>) => void;
    debug: (event: string, data?: Record<string, unknown>) => void;
    warn?: (event: string, data?: Record<string, unknown>) => void;
  };
  now?: () => Date;
};

export type LaneDeviceCreateArgs = {
  laneId: string;
  from?: string | null;
  runtime?: string | null;
  deviceType?: string | null;
  name?: string | null;
};

export type LaneDeviceRegistry = {
  deviceCreate(args: LaneDeviceCreateArgs): Promise<AppleLaneDevice>;
  /**
   * Bind an installed simulator to a lane.
   *
   * Three outcomes, and exactly one lane owns the device after all of them:
   * the lane already holds it (answered as-is), nobody holds it (a plain
   * attach), or another lane holds it (the binding MOVES — see `rebind`).
   *
   * With `agentCaller`, only the first: an agent may not take a simulator its
   * lane does not already hold (`AppleDeviceNotLaneOwnedError`).
   */
  deviceAttach(args: { laneId: string; simulator: string; agentCaller?: boolean | null }): Promise<AppleLaneDevice>;
  deviceList(args?: {
    installed?: boolean | null;
    laneId?: string | null;
    disk?: boolean | null;
    runtimes?: boolean | null;
  }): Promise<AppleDeviceListResult>;
  /**
   * Delete the lane's ADE device. An attached device is always refused: ADE never
   * deletes a simulator it did not create. Detaching one is `deviceDetach`.
   *
   * With `udid`, only that device: when the lane holds another one by now,
   * nothing happens, so a caller never deletes a device it did not read.
   */
  deviceDelete(args: { laneId: string; udid?: string | null }): Promise<void>;
  /**
   * Forget the lane's device and touch no simulator: a clone is not deleted
   * and nothing is powered off. Returns what was detached, or null when the
   * lane had no device.
   */
  deviceDetach(args: { laneId: string }): Promise<AppleLaneDevice | null>;
  /**
   * Delete an installed simulator by udid, for the picker's per-device menu.
   *
   * Separate from `deviceDelete`, which is "give up the device THIS lane
   * owns". This one is the owner clearing out a simulator they are not using,
   * usually for the disk, so it refuses any device a lane holds rather than
   * silently unbinding that lane. Removing a lane's own device is still
   * `deviceDelete`, which shuts its stream down first.
   */
  deviceDeleteInstalled(args: { udid: string }): Promise<void>;
  /** The lane's device without touching `simctl`. Null when the lane has none. */
  get(laneId: string): AppleLaneDevice | null;
  /** Every lane device this project knows about. */
  list(): AppleLaneDevice[];
  /** Create on first ask — what `launch` and `open-device` call. */
  ensure(args: { laneId: string }): Promise<AppleLaneDevice>;
  /**
   * Bring the rows, the marker files and the real device set back into line.
   *
   * - A row whose simulator no longer exists is dropped.
   * - A row whose lane ended (archived, deleted, or merged away) is released:
   *   an ADE device is deleted; an attached one is powered off and loses only
   *   the apps ADE installed.
   * - A marked ADE device of this project that no live lane holds is deleted.
   * - A row for an ADE device that has no marker (made before markers) gets one.
   *
   * Never throws; each failure is one entry in `errors`. Refuses to delete
   * anything when the device set cannot be read.
   */
  reconcile(): Promise<AppleDeviceCleanupResult>;
  /** Remember that ADE installed `bundleId` on `udid`, when `udid` is an attached lane device. */
  noteAppInstalled(args: { udid: string; bundleId: string }): void;
  /** True when the lane row exists and is not archived. Unknown (no store) reads as true. */
  isLaneLive(laneId: string): boolean;
};

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

/** Where CoreSimulator keeps one directory per simulator, all of its data in it. */
export function appleDeviceDataRoot(home = os.homedir()): string {
  return path.join(home, "Library", "Developer", "CoreSimulator", "Devices");
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
 * The runtime and device type a new lane device is made from.
 *
 * Order: an explicit `runtime`/`deviceType`, then `from` (an installed
 * simulator whose model and runtime to copy — never its data), then the newest
 * installed iOS runtime with the device type this project used last, else the
 * first iPhone that runtime lists (CoreSimulator lists the newest first).
 * Exported pure so the precedence is testable without `simctl`.
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
      ?? installed.find((device) => matchesName(device.name, from));
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
    : runtimes[0];
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

/** The marker ADE writes into a device directory it created. */
export type AppleDeviceMarker = {
  version: 1;
  projectRoot: string;
  laneId: string;
  name: string;
  createdAt: string;
};

export function appleDeviceMarkerPath(dataRoot: string, udid: string): string {
  return path.join(dataRoot, udid, APPLE_DEVICE_MARKER_FILE);
}

export function readAppleDeviceMarker(dataRoot: string, udid: string): AppleDeviceMarker | null {
  try {
    const raw = JSON.parse(fs.readFileSync(appleDeviceMarkerPath(dataRoot, udid), "utf8")) as Partial<AppleDeviceMarker>;
    if (typeof raw.projectRoot !== "string" || typeof raw.laneId !== "string") return null;
    return {
      version: 1,
      projectRoot: raw.projectRoot,
      laneId: raw.laneId,
      name: typeof raw.name === "string" ? raw.name : "",
      createdAt: typeof raw.createdAt === "string" ? raw.createdAt : "",
    };
  } catch {
    return null;
  }
}

/**
 * Write the marker. Only into a directory that exists: CoreSimulator creates it
 * with the device, and a marker without its device would describe nothing.
 */
export function writeAppleDeviceMarker(dataRoot: string, udid: string, marker: AppleDeviceMarker): boolean {
  const directory = path.join(dataRoot, udid);
  if (!fs.existsSync(directory)) return false;
  fs.writeFileSync(appleDeviceMarkerPath(dataRoot, udid), `${JSON.stringify(marker, null, 2)}\n`, "utf8");
  return true;
}

/** Every marked device directory under the device store. Unreadable entries are skipped. */
export function listAppleDeviceMarkers(dataRoot: string): Array<{ udid: string; marker: AppleDeviceMarker }> {
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(dataRoot);
  } catch {
    return [];
  }
  const found: Array<{ udid: string; marker: AppleDeviceMarker }> = [];
  for (const udid of entries) {
    if (!/^[0-9A-F-]{20,}$/iu.test(udid)) continue;
    const marker = readAppleDeviceMarker(dataRoot, udid);
    if (marker) found.push({ udid, marker });
  }
  return found;
}

/** Two project roots name the same project. Case and a trailing slash do not matter. */
function sameProjectRoot(a: string, b: string): boolean {
  const normalize = (value: string) => path.resolve(value).replace(/\/+$/u, "").toLowerCase();
  return normalize(a) === normalize(b);
}

/** `ADE · lane`, `ADE Repro`: a name ADE made, or a person named after it. Evidence only for the storage view. */
export function looksLikeAdeDeviceName(name: string): boolean {
  return /^ADE(\s|·|$)/u.test(name.trim());
}

/**
 * The lane device's name.
 *
 * `ADE · <lane>` is the locked pattern: the separator makes an ADE device
 * obvious in Xcode's own device list, which is the list a user reaches for when
 * something looks wrong. A collision gets a numeric suffix rather than being
 * refused — two lanes can legitimately carry the same display name.
 */
export function appleLaneDeviceName(input: {
  laneId: string;
  laneName?: string | null;
  requested?: string | null;
  taken?: string[];
}): string {
  const requested = input.requested?.trim();
  const label = (input.laneName?.trim() || input.laneId.slice(0, 8)).replace(/\s+/g, " ");
  const base = requested || `ADE · ${label}`;
  const taken = new Set(input.taken ?? []);
  if (!taken.has(base)) return base;
  for (let suffix = 2; suffix < 100; suffix += 1) {
    const candidate = `${base} (${suffix})`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${base} (${Date.now()})`;
}

/**
 * Does this string name the device the lane already holds?
 *
 * The same udid-then-name precedence `deviceAttach` matches installed
 * simulators with, so "attach the device I already have" is recognised without
 * a `simctl` call — and so a re-attach is never mistaken for a takeover of
 * somebody else's device.
 */
export function namesLaneDevice(device: AppleLaneDevice, wanted: string): boolean {
  const trimmed = wanted.trim();
  if (!trimmed) return false;
  return device.udid === trimmed
    || device.name === trimmed
    || device.name.toLowerCase() === trimmed.toLowerCase();
}

type LaneDeviceRow = {
  lane_id: string;
  udid: string;
  name: string;
  origin: string;
  family: string;
  runtime: string;
  created_at: string;
  template_udid: string | null;
};

/**
 * Anything that is not `attached` is ADE's. An unknown value from a newer ADE
 * reads as `clone` rather than as the user's, so it is still deleted with its
 * lane instead of being kept forever.
 */
function rowOrigin(value: string): AppleLaneDeviceOrigin {
  if (value === "attached") return "attached";
  if (value === "created") return "created";
  return "clone";
}

function rowToDevice(row: LaneDeviceRow): AppleLaneDevice {
  return {
    laneId: row.lane_id,
    udid: row.udid,
    name: row.name,
    origin: rowOrigin(row.origin),
    family: row.family === "ipad" || row.family === "watch" ? row.family : "iphone",
    runtime: row.runtime,
    createdAt: row.created_at,
    templateUdid: row.template_udid ?? null,
  };
}

const LANE_DEVICE_COLUMNS = "lane_id, udid, name, origin, family, runtime, created_at, template_udid";

/**
 * The lane's bound device, straight from `lane_apple_devices` — one indexed
 * row read, never `simctl`.
 *
 * Standalone (like `releaseLaneAppleDevice`) so a host that never built the
 * simulator service can still ask which device a lane owns: the chat send path
 * reads it to tell the agent about the lane's device. Throws on a store error;
 * callers decide whether that is fatal.
 */
export function readLaneAppleDevice(
  store: Pick<LaneDeviceStore, "get">,
  laneId: string,
): AppleLaneDevice | null {
  const trimmed = laneId.trim();
  if (!trimmed) return null;
  const row = store.get<LaneDeviceRow>(
    `select ${LANE_DEVICE_COLUMNS} from ${LANE_APPLE_DEVICES_TABLE} where lane_id = ?`,
    [trimmed],
  );
  return row ? rowToDevice(row) : null;
}

export function createLaneDeviceRegistry(deps: LaneDeviceRegistryDeps): LaneDeviceRegistry {
  const now = deps.now ?? (() => new Date());
  // Used only when no lanes DB was handed in — the CLI's chat-only runtime has
  // no store, and a lane device that vanishes on restart is better there than a
  // crash on every call.
  const memory = new Map<string, AppleLaneDevice>();

  const readAll = (): AppleLaneDevice[] => {
    if (!deps.store) return [...memory.values()];
    try {
      return deps.store
        .all<LaneDeviceRow>(`select ${LANE_DEVICE_COLUMNS} from ${LANE_APPLE_DEVICES_TABLE}`)
        .map(rowToDevice);
    } catch (error) {
      deps.logger.debug("apple.lane_device_read_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  };

  const readOne = (laneId: string): AppleLaneDevice | null => {
    const trimmed = laneId.trim();
    if (!trimmed) return null;
    if (!deps.store) return memory.get(trimmed) ?? null;
    try {
      return readLaneAppleDevice(deps.store, trimmed);
    } catch (error) {
      deps.logger.debug("apple.lane_device_read_failed", {
        laneId: trimmed,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  };

  const write = (device: AppleLaneDevice): void => {
    if (!deps.store) {
      memory.set(device.laneId, device);
      return;
    }
    deps.store.run(
      `insert into ${LANE_APPLE_DEVICES_TABLE} (lane_id, udid, name, origin, family, runtime, created_at, template_udid)
       values (?, ?, ?, ?, ?, ?, ?, ?)
       on conflict(lane_id) do update set
         udid = excluded.udid,
         name = excluded.name,
         origin = excluded.origin,
         family = excluded.family,
         runtime = excluded.runtime,
         created_at = excluded.created_at,
         template_udid = excluded.template_udid`,
      [
        device.laneId,
        device.udid,
        device.name,
        device.origin,
        device.family,
        device.runtime,
        device.createdAt,
        device.templateUdid,
      ],
    );
  };

  /**
   * Move one device's binding from one lane to another, in ONE step.
   *
   * `lane_id` is this table's primary key, so re-keying the row IS the move:
   * there is no instant at which both lanes own the device, and no row is left
   * behind for the old lane to read. A delete-then-insert pair would have a
   * window between the two statements, and a crash inside it would leave the
   * device owned by nobody at best and by both at worst.
   *
   * `origin` and `template_udid` are deliberately not in the SET list — they
   * describe the simulator, and they travel with it.
   */
  const rebind = (previous: AppleLaneDevice, device: AppleLaneDevice): void => {
    if (!deps.store) {
      memory.delete(previous.laneId);
      memory.set(device.laneId, device);
      return;
    }
    deps.store.run(
      `update ${LANE_APPLE_DEVICES_TABLE}
          set lane_id = ?, name = ?, family = ?, runtime = ?, created_at = ?
        where lane_id = ? and udid = ?`,
      [
        device.laneId,
        device.name,
        device.family,
        device.runtime,
        device.createdAt,
        previous.laneId,
        previous.udid,
      ],
    );
  };

  const forget = (laneId: string): void => {
    if (!deps.store) {
      memory.delete(laneId);
      return;
    }
    deps.store.run(`delete from ${LANE_APPLE_DEVICES_TABLE} where lane_id = ?`, [laneId]);
  };

  /**
   * Mark a device as ADE's. Never fails the caller: a device without a marker
   * is still deleted with its lane through the row; the marker is what finds it
   * when the row is lost.
   */
  const writeMarker = (udid: string, marker: { laneId: string; name: string; createdAt: string }): void => {
    const projectRoot = deps.projectRoot?.trim();
    if (!projectRoot) return;
    try {
      writeAppleDeviceMarker(dataRoot(), udid, { version: 1, projectRoot, ...marker });
    } catch (error) {
      deps.logger.warn?.("apple.lane_device_marker_write_failed", {
        udid,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const isLaneLive = (laneId: string): boolean => {
    if (!deps.store) return true;
    try {
      const row = deps.store.get<{ status: string | null }>("select status from lanes where id = ?", [laneId]);
      return Boolean(row) && row?.status !== "archived";
    } catch {
      // A read that failed says nothing about the lane. Treat it as live, so
      // nothing is deleted on a guess.
      return true;
    }
  };

  const readInstalledApps = (): Record<string, string[]> => {
    try {
      const value = deps.store?.getJson<Record<string, string[]>>(APPLE_ADE_INSTALLED_APPS_KEY);
      return value && typeof value === "object" ? value : {};
    } catch {
      return {};
    }
  };

  const noteAppInstalled = (args: { udid: string; bundleId: string }): void => {
    const udid = args.udid.trim();
    const bundleId = args.bundleId.trim();
    if (!udid || !bundleId || !deps.store) return;
    // Only an attached device needs this. An ADE device is deleted whole.
    const holder = readAll().find((device) => device.udid === udid);
    if (!holder || holder.origin !== "attached") return;
    const apps = readInstalledApps();
    const list = new Set(apps[udid] ?? []);
    if (list.has(bundleId)) return;
    list.add(bundleId);
    try {
      deps.store.setJson(APPLE_ADE_INSTALLED_APPS_KEY, { ...apps, [udid]: [...list] });
    } catch (error) {
      deps.logger.debug("apple.installed_app_note_failed", {
        udid,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const rememberDeviceType = (identifier: string): void => {
    try {
      deps.store?.setJson(APPLE_LAST_DEVICE_TYPE_KEY, identifier);
    } catch (error) {
      deps.logger.debug("apple.device_type_remember_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const lastDeviceType = (): string | null => {
    try {
      const value = deps.store?.getJson<string>(APPLE_LAST_DEVICE_TYPE_KEY);
      return typeof value === "string" && value.trim() ? value.trim() : null;
    } catch {
      return null;
    }
  };

  const dataRoot = (): string => deps.deviceDataRoot?.trim() || appleDeviceDataRoot();

  const listRuntimes = async (): Promise<AppleInstalledRuntime[]> => {
    if (deps.listInstalledRuntimes) return deps.listInstalledRuntimes();
    const { stdout } = await deps.run("xcrun", ["simctl", "list", "runtimes", "available", "--json"], { timeoutMs: 30_000 });
    return parseAppleInstalledRuntimes(stdout);
  };

  /**
   * The lane's display name, for the device's name.
   *
   * Read straight from the `lanes` table when no resolver was injected: the
   * hosts hand this registry the same database the lane row lives in, and a
   * synchronous read here is what lets `appleLaneDeviceName` stay pure. Falls
   * back to the id, which is what an un-named lane has anyway.
   */
  const laneNameFor = (laneId: string): string | null => {
    const injected = deps.resolveLaneName?.(laneId);
    if (injected) return injected;
    try {
      return deps.store?.get<{ name: string | null }>("select name from lanes where id = ?", [laneId])?.name ?? null;
    } catch {
      return null;
    }
  };

  /**
   * Who holds what, by display name, for the lane that is asking.
   *
   * Built from EVERY lane's row, not the caller's: a picker that cannot see
   * lane B's binding offers Open on lane B's device, which is the defect this
   * exists to close. The lane name is resolved per row — five rows at most on
   * a real machine — and a missing name degrades to null rather than to the
   * id, so the renderer decides how to word "a lane we cannot name".
   */
  const ownersFor = (laneId: string | null): AppleSimulatorOwner[] =>
    readAll().map((device) => ({
      udid: device.udid,
      laneId: device.laneId,
      laneName: laneNameFor(device.laneId),
      origin: device.origin,
      mine: laneId != null && device.laneId === laneId,
    }));

  /**
   * The disk measurement, cached for a minute.
   *
   * The picker asks once per open, but the pane re-lists on every refresh and
   * on every device event; a `du` per event would turn a status poll into a
   * filesystem walk. A minute is short enough that a delete the user just made
   * shows up while they are still looking at the page.
   */
  let diskCache: { at: number; value: AppleDeviceDiskUsage } | null = null;
  const DISK_CACHE_MS = 60_000;

  const measureDisk = async (): Promise<AppleDeviceDiskUsage | null> => {
    const root = deps.deviceDataRoot?.trim() || appleDeviceDataRoot();
    const cached = diskCache;
    if (cached && Date.now() - cached.at < DISK_CACHE_MS && cached.value.root === root) {
      return cached.value;
    }
    let stdout = "";
    try {
      ({ stdout } = await deps.run("du", ["-d", "1", "-k", root], { timeoutMs: 120_000 }));
    } catch (error) {
      // A store that is not there yet, or a `du` that hit a permission wall, is
      // an unknown number — never a failed device list. The picker simply says
      // nothing about disk.
      deps.logger.debug("apple.device_disk_measure_failed", {
        root,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
    const parsed = parseAppleDeviceDiskUsage({ stdout, root });
    const value: AppleDeviceDiskUsage = {
      totalBytes: parsed.totalBytes,
      devices: parsed.devices,
      root,
      measuredAt: now().toISOString(),
    };
    diskCache = { at: Date.now(), value };
    return value;
  };

  const requireLaneId = (laneId: string | null | undefined): string => {
    const trimmed = laneId?.trim();
    if (!trimmed) throw new Error("A laneId is required: an Apple device belongs to exactly one lane.");
    return trimmed;
  };

  const create = async (args: LaneDeviceCreateArgs): Promise<AppleLaneDevice> => {
    const laneId = requireLaneId(args.laneId);
    const existing = readOne(laneId);
    if (existing) throw new AppleDeviceExistsError(existing);
    const [runtimes, installed] = await Promise.all([
      listRuntimes(),
      // Only `from` and the name collision check need it.
      deps.listInstalledSimulators(),
    ]);
    const spec = pickAppleDeviceSpec({
      runtimes,
      installed,
      runtime: args.runtime,
      deviceType: args.deviceType,
      from: args.from,
      lastDeviceType: lastDeviceType(),
    });
    const name = appleLaneDeviceName({
      laneId,
      laneName: laneNameFor(laneId),
      requested: args.name,
      taken: installed.map((device) => device.name),
    });
    // `simctl create` prints the new udid and nothing else. Anything on stderr
    // is a warning, not the answer, which is why only stdout is parsed.
    const { stdout } = await deps.run(
      "xcrun",
      ["simctl", "create", name, spec.deviceType.identifier, spec.runtime.identifier],
      { timeoutMs: 120_000 },
    );
    const udid = stdout.trim().split(/\s+/).filter(Boolean).pop() ?? "";
    if (!udid) {
      throw new Error(`simctl create did not report a udid for ${name}. Check \`xcrun simctl list devices\` and try again.`);
    }
    const createdAt = now().toISOString();
    // The marker first, then the row: a crash between the two leaves a marked
    // device with no row, which the cleanup pass re-adopts or deletes. The other
    // order would leave an unmarked device, which nothing would ever delete.
    writeMarker(udid, { laneId, name, createdAt });
    const device: AppleLaneDevice = {
      laneId,
      udid,
      name,
      origin: "created",
      family: spec.deviceType.family,
      runtime: spec.runtime.name,
      createdAt,
      templateUdid: null,
    };
    write(device);
    rememberDeviceType(spec.deviceType.identifier);
    deps.logger.info("apple.lane_device_created", {
      laneId,
      udid,
      name,
      runtime: spec.runtime.identifier,
      deviceType: spec.deviceType.identifier,
    });
    return device;
  };

  const attach = async (args: { laneId: string; simulator: string; agentCaller?: boolean | null }): Promise<AppleLaneDevice> => {
    const laneId = requireLaneId(args.laneId);
    const wanted = args.simulator?.trim();
    if (!wanted) throw new Error("device-attach needs a simulator udid or name.");
    const existing = readOne(laneId);
    if (existing) {
      // Already ours. An attach of the device this lane holds is the state the
      // caller asked for, so it is answered, not refused and not moved —
      // checked before `simctl` is consulted, because it needs no device list.
      if (namesLaneDevice(existing, wanted)) return existing;
      throw new AppleDeviceExistsError(existing);
    }
    const installed = await deps.listInstalledSimulators();
    if (!installed.length) throw new AppleNoInstalledSimulatorsError();
    const match = installed.find((device) => device.udid === wanted)
      ?? installed.find((device) => device.name === wanted)
      ?? installed.find((device) => device.name.toLowerCase() === wanted.toLowerCase());
    if (!match) {
      throw new Error(`No installed simulator matches ${wanted}. Run device-list --installed to see what this Mac has.`);
    }
    /*
     * EVERY other lane holding this udid, not just the first.
     *
     * `rebind` moves one row. On the owner's machine ADE Repro was bound to
     * two lanes at once — a state this code is supposed to make impossible,
     * and which predates the atomic move — and a takeover would have moved one
     * row and left the other, so the duplicate survived the very operation
     * meant to end it. Two lanes believing they own one simulator is how one
     * powers it off under the other.
     */
    const holders = readAll().filter((device) => device.udid === match.udid && device.laneId !== laneId);
    /*
     * An agent may attach an installed simulator that no lane holds: that is
     * the user naming a device for the lane ("use my iPhone 17 Pro"). It may
     * never take one another lane holds — that is a takeover, and a takeover
     * stays the user's, through the picker, which never sets this flag.
     */
    if (args.agentCaller && holders.length) {
      const holder = holders[0]!;
      const reason: AppleDeviceNotLaneOwnedReason = { kind: "other-lane", laneLabel: laneNameFor(holder.laneId) ?? holder.laneId };
      deps.logger.info("apple.lane_device_attach_refused_agent", {
        laneId,
        udid: match.udid,
        reason: reason.kind,
        holderLaneId: holder.laneId,
      });
      throw new AppleDeviceNotLaneOwnedError(match, reason);
    }
    if (holders.length > 1) {
      // Impossible by construction, so say so rather than repairing in silence.
      deps.logger.warn?.("apple.lane_device_multiple_holders", {
        udid: match.udid,
        laneIds: holders.map((device) => device.laneId),
      });
    }
    const previous = holders[0] ?? null;
    const device: AppleLaneDevice = {
      laneId,
      udid: match.udid,
      name: match.name,
      /*
       * On a takeover, `origin` and `templateUdid` travel WITH the device, not
       * with the lane. They describe where the simulator came from: a clone ADE
       * made is still ADE's to delete after it changes hands, and re-labelling
       * it "attached" would leak that clone forever when the new lane is
       * archived. `createdAt` is the opposite — it dates the BINDING, so it is
       * now.
       */
      origin: previous?.origin ?? "attached",
      family: match.family,
      runtime: match.runtime,
      createdAt: now().toISOString(),
      templateUdid: previous?.templateUdid ?? null,
    };
    if (previous) {
      /*
       * A takeover MOVES the binding. Nothing here may leave two lanes owning
       * one simulator: both would believe it is theirs, and either could power
       * it off or delete it out from under the other. The picker's "Take
       * over…" button is what makes this reachable, so the rule lives at the
       * only door — every surface attaches through here.
       *
       * The losing lane is released FIRST, while it still owns the row, so it
       * never holds a live stream on a device it no longer owns. A release that
       * fails is logged and the move still happens: a stream that would not
       * stop must not strand the binding half-moved.
       */
      // try/catch rather than `.catch` on the returned promise: a hook that
      // throws SYNCHRONOUSLY never produces a promise to attach a handler to,
      // and that throw would have escaped and left the binding unmoved.
      try {
        await deps.releaseLaneDevice?.(previous);
      } catch (error) {
        deps.logger.warn?.("apple.lane_device_release_failed", {
          laneId: previous.laneId,
          udid: previous.udid,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      rebind(previous, device);
      // Any remaining holder is dropped, never moved: the binding has already
      // landed on this lane, and a second `rebind` would move it straight back
      // out again.
      for (const stale of holders.slice(1)) forget(stale.laneId);
      deps.logger.info("apple.lane_device_moved", {
        laneId,
        fromLaneId: previous.laneId,
        udid: device.udid,
        name: device.name,
        origin: device.origin,
      });
      return device;
    }
    write(device);
    deps.logger.info("apple.lane_device_attached", { laneId, udid: device.udid, name: device.name });
    return device;
  };

  const remove = async (args: { laneId: string; udid?: string | null }): Promise<void> => {
    const laneId = requireLaneId(args.laneId);
    const device = readOne(laneId);
    if (!device) return;
    if (args.udid && device.udid !== args.udid) {
      deps.logger.info("apple.lane_device_delete_skipped_changed", { laneId, expected: args.udid, actual: device.udid });
      return;
    }
    // ADE does not delete a simulator it did not create: a user's own device
    // being erased because a lane was archived is not a recoverable mistake.
    if (!isAdeOwnedLaneDevice(device.origin)) throw new AppleDeviceAttachedNotDeletableError(device);
    await deps.powerOffDevice(device.udid).catch((error: unknown) => {
      deps.logger.debug("apple.lane_device_shutdown_failed", {
        laneId,
        udid: device.udid,
        error: error instanceof Error ? error.message : String(error),
      });
    });
    try {
      await deps.run("xcrun", ["simctl", "delete", device.udid], { timeoutMs: 120_000 });
    } catch (error) {
      // A device the user already deleted in Xcode must not strand the row.
      deps.logger.warn?.("apple.lane_device_delete_failed", {
        laneId,
        udid: device.udid,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    forget(laneId);
    deps.logger.info("apple.lane_device_deleted", { laneId, udid: device.udid });
  };

  /**
   * Delete one installed simulator the owner picked out of the list.
   *
   * Refuses anything a lane holds. The picker already renders those as taken
   * and offers no menu, but the guard belongs here: a CLI caller and a stale
   * renderer reach this same method, and the cost of getting it wrong is
   * another lane's live view vanishing mid-test.
   *
   * ADE's "never delete a simulator it did not create" rule governs what ADE
   * does BY ITSELF — on lane archive, without anyone asking. An owner clicking
   * Delete on a named device in a confirmed menu is the opposite of that, and
   * reclaiming the disk is usually the whole point.
   */
  const removeInstalled = async (args: { udid: string }): Promise<void> => {
    const udid = args.udid?.trim();
    if (!udid) throw new Error("A simulator udid is required.");
    const holder = readAll().find((device) => device.udid === udid);
    if (holder) throw new AppleDeviceOwnedByLaneError(holder);
    await deps.powerOffDevice(udid).catch((error: unknown) => {
      deps.logger.debug("apple.installed_device_shutdown_failed", {
        udid,
        error: error instanceof Error ? error.message : String(error),
      });
    });
    await deps.run("xcrun", ["simctl", "delete", udid], { timeoutMs: 120_000 });
    deps.logger.info("apple.installed_device_deleted", { udid });
  };

  /** Who each installed simulator belongs to, for the storage view. */
  const ownershipFor = (installed: AppleInstalledSimulator[]): AppleSimulatorOwnershipInfo[] => {
    const rows = new Set(readAll().map((device) => device.udid));
    const root = dataRoot();
    const projectRoot = deps.projectRoot?.trim() || null;
    return installed.map((device) => {
      const marker = readAppleDeviceMarker(root, device.udid);
      const ownership: AppleSimulatorOwnershipInfo["ownership"] = rows.has(device.udid)
        ? "lane"
        : marker
          ? projectRoot && !sameProjectRoot(marker.projectRoot, projectRoot)
            ? "ade-other-project"
            : "ade-orphan"
          : "unknown";
      return {
        udid: device.udid,
        ownership,
        markerLaneId: marker?.laneId ?? null,
        looksLikeAde: !marker && looksLikeAdeDeviceName(device.name),
      };
    });
  };

  /** Delete a device ADE made that no lane holds. Every step is best effort; true when simctl deleted it. */
  const deleteUnheldAdeDevice = async (udid: string): Promise<boolean> => {
    await deps.releaseDeviceHolds?.(udid).catch(() => undefined);
    await deps.powerOffDevice(udid).catch(() => undefined);
    await deps.run("xcrun", ["simctl", "delete", udid], { timeoutMs: 120_000 });
    return true;
  };

  const reconcile = async (): Promise<AppleDeviceCleanupResult> => {
    const result: AppleDeviceCleanupResult = { deleted: [], poweredOff: [], forgottenRows: [], released: [], errors: [] };
    const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));
    let all: Map<string, { name: string; state: string; runtime: string }>;
    try {
      const { stdout } = await deps.run("xcrun", ["simctl", "list", "devices", "--json"], { timeoutMs: 30_000 });
      all = parseAppleDeviceSet(stdout);
    } catch (error) {
      // Nothing is deleted on a device set ADE could not read: an empty answer
      // would otherwise read as "every row's simulator is gone".
      result.errors.push({ udid: null, message: `Could not read the simulator list: ${errorText(error)}` });
      return result;
    }
    const root = dataRoot();

    for (const row of readAll()) {
      if (!all.has(row.udid)) {
        // Deleted outside ADE (Xcode, `simctl delete`). The row is all that is left.
        try {
          forget(row.laneId);
          result.forgottenRows.push({ laneId: row.laneId, udid: row.udid });
        } catch (error) {
          result.errors.push({ udid: row.udid, message: errorText(error) });
        }
        continue;
      }
      if (!isLaneLive(row.laneId)) {
        try {
          await deps.releaseDeviceHolds?.(row.udid).catch(() => undefined);
          const ended = await endLaneDeviceOnDisk({ device: row, run: deps.run, store: deps.store ?? null, logger: deps.logger });
          forget(row.laneId);
          result.released.push({ laneId: row.laneId, udid: row.udid });
          if (ended.deleted) result.deleted.push({ udid: row.udid, name: row.name, reason: "lane ended" });
        } catch (error) {
          result.errors.push({ udid: row.udid, message: errorText(error) });
        }
        continue;
      }
      // A device made before markers existed: give it one, so a lost row can
      // no longer turn it into a device nobody deletes.
      if (isAdeOwnedLaneDevice(row.origin) && !readAppleDeviceMarker(root, row.udid)) {
        writeMarker(row.udid, { laneId: row.laneId, name: row.name, createdAt: row.createdAt });
      }
    }

    const held = new Set(readAll().map((device) => device.udid));
    const projectRoot = deps.projectRoot?.trim() || null;
    const nowMs = now().getTime();
    for (const { udid, marker } of listAppleDeviceMarkers(root)) {
      if (held.has(udid)) continue;
      const listed = all.get(udid);
      if (!listed) continue;
      const ours = projectRoot ? sameProjectRoot(marker.projectRoot, projectRoot) : false;
      const projectGone = !fs.existsSync(path.join(marker.projectRoot, ".ade"));
      if (!ours && !projectGone) continue;
      const createdMs = Date.parse(marker.createdAt);
      if (Number.isFinite(createdMs) && nowMs - createdMs < MARKER_GRACE_MS) continue;
      if (ours && isLaneLive(marker.laneId) && !readOne(marker.laneId)) {
        // The lane is still here and lost only its row. Give the device back.
        try {
          write({
            laneId: marker.laneId,
            udid,
            name: listed.name,
            origin: "created",
            family: appleDeviceFamily({ name: listed.name }),
            runtime: listed.runtime,
            createdAt: marker.createdAt || now().toISOString(),
            templateUdid: null,
          });
          held.add(udid);
          deps.logger.info("apple.lane_device_readopted", { laneId: marker.laneId, udid });
        } catch (error) {
          result.errors.push({ udid, message: errorText(error) });
        }
        continue;
      }
      try {
        await deleteUnheldAdeDevice(udid);
        result.deleted.push({
          udid,
          name: listed.name,
          reason: projectGone && !ours ? "its project no longer exists" : "no live lane holds it",
        });
      } catch (error) {
        result.errors.push({ udid, message: errorText(error) });
      }
    }
    if (result.deleted.length || result.forgottenRows.length || result.released.length || result.errors.length) {
      deps.logger.info("apple.lane_devices_reconciled", {
        deleted: result.deleted.map((entry) => entry.udid),
        forgottenRows: result.forgottenRows.length,
        released: result.released.length,
        errors: result.errors.length,
      });
    }
    return result;
  };

  return {
    deviceCreate: create,
    deviceAttach: attach,
    deviceDeleteInstalled: removeInstalled,
    async deviceList(args = {}) {
      const wantInstalled = args.installed !== false;
      const installed = wantInstalled ? await deps.listInstalledSimulators() : [];
      const laneId = args.laneId?.trim() || null;
      const [disk, runtimes] = await Promise.all([
        args.disk ? measureDisk() : Promise.resolve(null),
        args.runtimes ? listRuntimes().catch(() => []) : Promise.resolve(null),
      ]);
      return {
        installed,
        lane: laneId ? readOne(laneId) : null,
        owners: ownersFor(laneId),
        laneId,
        disk,
        ...(runtimes ? { runtimes } : {}),
        // The storage read asks with `installed: false`; ownership still needs the list.
        ...(args.disk
          ? { ownership: ownershipFor(wantInstalled ? installed : await deps.listInstalledSimulators().catch(() => [])) }
          : {}),
      };
    },
    deviceDelete: remove,
    async deviceDetach(args: { laneId: string }) {
      const laneId = requireLaneId(args.laneId);
      const device = readOne(laneId);
      if (!device) return null;
      forget(laneId);
      deps.logger.info("apple.lane_device_detached", { laneId, udid: device.udid, origin: device.origin });
      return device;
    },
    get: (laneId: string) => readOne(laneId),
    list: readAll,
    async ensure(args: { laneId: string }) {
      const laneId = requireLaneId(args.laneId);
      const existing = readOne(laneId);
      if (existing) return existing;
      return create({ laneId });
    },
    reconcile,
    noteAppInstalled,
    isLaneLive,
  };
}

/** `simctl list devices --json`, every device including unavailable ones, by udid. */
export function parseAppleDeviceSet(stdout: string): Map<string, { name: string; state: string; runtime: string }> {
  const parsed = JSON.parse(stdout) as { devices?: Record<string, Array<{ udid?: string; name?: string; state?: string }>> };
  if (!parsed || typeof parsed.devices !== "object" || parsed.devices === null) {
    throw new Error("simctl list devices returned no device set");
  }
  const all = new Map<string, { name: string; state: string; runtime: string }>();
  for (const [runtime, devices] of Object.entries(parsed.devices)) {
    const runtimeName = (runtime.split(".").pop() ?? runtime).replace(/^([A-Za-z]+)-(\d+)-(\d+)$/u, "$1 $2.$3");
    for (const device of devices ?? []) {
      if (!device.udid) continue;
      all.set(device.udid, { name: device.name ?? device.udid, state: device.state ?? "Unknown", runtime: runtimeName });
    }
  }
  return all;
}

/**
 * What ending a lane does to its device on disk.
 *
 * - An ADE device is powered off and deleted, with all its data.
 * - An attached device is the user's. It keeps everything the user put on it:
 *   ADE uninstalls only the apps ADE installed (their data is where the space
 *   goes), then powers it off. `simctl uninstall` needs a booted device, so a
 *   device that is off is booted for the uninstall and powered off again.
 *
 * Each step is best effort. Returns what happened.
 */
export async function endLaneDeviceOnDisk(input: {
  device: AppleLaneDevice;
  run: RunCommand;
  store?: Pick<LaneDeviceStore, "getJson" | "setJson"> | null;
  logger: { warn?: (event: string, data?: Record<string, unknown>) => void; info: (event: string, data?: Record<string, unknown>) => void };
}): Promise<{ deleted: boolean; poweredOff: boolean; uninstalled: string[] }> {
  const { device, run, logger } = input;
  const powerOff = bareSimulatorPowerOff(run);
  const warn = (event: string, error: unknown) => logger.warn?.(event, {
    laneId: device.laneId,
    udid: device.udid,
    error: error instanceof Error ? error.message : String(error),
  });
  if (isAdeOwnedLaneDevice(device.origin)) {
    await powerOff(device.udid).catch(() => false);
    try {
      await run("xcrun", ["simctl", "delete", device.udid], { timeoutMs: 120_000 });
      return { deleted: true, poweredOff: true, uninstalled: [] };
    } catch (error) {
      warn("lane.end.apple_device_delete_failed", error);
      return { deleted: false, poweredOff: true, uninstalled: [] };
    }
  }
  let apps: Record<string, string[]> = {};
  try {
    apps = input.store?.getJson<Record<string, string[]>>(APPLE_ADE_INSTALLED_APPS_KEY) ?? {};
  } catch {
    apps = {};
  }
  const bundleIds = apps[device.udid] ?? [];
  const uninstalled: string[] = [];
  if (bundleIds.length) {
    const state = await run("xcrun", ["simctl", "list", "devices", "--json"], { timeoutMs: 30_000 })
      .then((result) => parseAppleDeviceSet(result.stdout).get(device.udid)?.state ?? null)
      .catch(() => null);
    if (state !== "Booted") {
      await run("xcrun", ["simctl", "boot", device.udid], { timeoutMs: 120_000 }).catch(() => undefined);
      await run("xcrun", ["simctl", "bootstatus", device.udid, "-b"], { timeoutMs: 180_000 }).catch(() => undefined);
    }
    for (const bundleId of bundleIds) {
      try {
        await run("xcrun", ["simctl", "uninstall", device.udid, bundleId], { timeoutMs: 60_000 });
        uninstalled.push(bundleId);
      } catch (error) {
        warn("lane.end.apple_app_uninstall_failed", error);
      }
    }
    /*
     * Let the uninstall settle before the power goes. Measured on iOS 26.3: a
     * `simctl shutdown` straight after `simctl uninstall` sometimes brings the
     * app back on the next boot, although `listapps` said it was gone. Five
     * seconds between the two kept it gone in every run.
     */
    if (uninstalled.length) await new Promise((resolve) => setTimeout(resolve, UNINSTALL_SETTLE_MS));
    try {
      const { [device.udid]: _dropped, ...rest } = apps;
      input.store?.setJson(APPLE_ADE_INSTALLED_APPS_KEY, rest);
    } catch (error) {
      warn("lane.end.apple_installed_apps_forget_failed", error);
    }
  }
  const poweredOff = await powerOff(device.udid).catch(() => false);
  logger.info("lane.end.apple_attached_device_released", { laneId: device.laneId, udid: device.udid, uninstalled });
  return { deleted: false, poweredOff, uninstalled };
}

/**
 * Everything a deleted or archived lane owns on the Apple side.
 *
 * Called from `laneService`'s archive and delete paths, and deliberately
 * standalone rather than a method on the simulator service: lane archive and
 * deletion run in hosts that never constructed one (the headless brain with
 * `--chat-only`, the reap-vanished-worktrees sweep), and a lane whose device
 * survived because no service happened to be alive is a simulator nobody will
 * ever delete. The cleanup pass catches what this misses.
 *
 * The rules:
 *
 * - An ADE device (`created`, or `clone` from before) is deleted with all its
 *   data — on archive AND on delete. An unarchived lane gets a new device.
 * - An `attached` device is the user's: powered off, the apps ADE installed
 *   uninstalled, and unbound. ADE never deletes a simulator it did not create.
 * - The lane's build cache (`derivedDataDirectories`) goes too; the next build
 *   rebuilds it.
 * - Recordings go only when `removeRecordings` (lane delete). An archived lane
 *   keeps its proof.
 * - Failures are logged, never thrown. This runs inside an archive or delete
 *   that has already happened; aborting it would leave the lane half-gone.
 *
 * Fire-and-forget by design: the caller does not await it, because a
 * `simctl delete` can take tens of seconds on a large device set and the lane
 * change is already done.
 */
export async function releaseLaneAppleDevice(input: {
  laneId: string;
  projectRoot: string;
  store: Pick<LaneDeviceStore, "get" | "run"> & Partial<Pick<LaneDeviceStore, "getJson" | "setJson">>;
  run: RunCommand;
  removeDirectory: (directory: string) => Promise<void>;
  /** Default true. False on archive, which keeps the lane's recordings. */
  removeRecordings?: boolean;
  /** The lane's DerivedData caches, deleted whole. */
  derivedDataDirectories?: string[];
  logger: {
    info: (event: string, data?: Record<string, unknown>) => void;
    warn: (event: string, data?: Record<string, unknown>) => void;
  };
}): Promise<{ deletedUdid: string | null; detachedUdid: string | null; removedRecordings: boolean; removedDerivedData: number }> {
  const laneId = input.laneId.trim();
  const result = {
    deletedUdid: null as string | null,
    detachedUdid: null as string | null,
    removedRecordings: false,
    removedDerivedData: 0,
  };
  if (!laneId) return result;

  let row: LaneDeviceRow | null = null;
  try {
    row = input.store.get<LaneDeviceRow>(
      `select ${LANE_DEVICE_COLUMNS} from ${LANE_APPLE_DEVICES_TABLE} where lane_id = ?`,
      [laneId],
    );
  } catch (error) {
    // The table is created by the same migration that created `lanes`, so a
    // miss here means a database older than this feature — not a failure.
    input.logger.warn("lane.delete.apple_device_read_failed", {
      laneId,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  if (row) {
    const device = rowToDevice(row);
    if (process.platform === "darwin") {
      const ended = await endLaneDeviceOnDisk({
        device,
        run: input.run,
        store: input.store.getJson && input.store.setJson
          ? { getJson: input.store.getJson.bind(input.store), setJson: input.store.setJson.bind(input.store) } as Pick<LaneDeviceStore, "getJson" | "setJson">
          : null,
        logger: input.logger,
      });
      if (ended.deleted) result.deletedUdid = device.udid;
      else if (!isAdeOwnedLaneDevice(device.origin)) result.detachedUdid = device.udid;
    } else if (!isAdeOwnedLaneDevice(device.origin)) {
      result.detachedUdid = device.udid;
    }
    try {
      input.store.run(`delete from ${LANE_APPLE_DEVICES_TABLE} where lane_id = ?`, [laneId]);
    } catch (error) {
      input.logger.warn("lane.delete.apple_device_row_remove_failed", {
        laneId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  for (const directory of input.derivedDataDirectories ?? []) {
    try {
      await input.removeDirectory(directory);
      result.removedDerivedData += 1;
    } catch (error) {
      input.logger.warn("lane.end.apple_derived_data_remove_failed", {
        laneId,
        directory,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (input.removeRecordings !== false) {
    const recordingsDir = appleRecordingsDirectory(input.projectRoot, laneId);
    try {
      await input.removeDirectory(recordingsDir);
      result.removedRecordings = true;
    } catch (error) {
      input.logger.warn("lane.delete.apple_recordings_remove_failed", {
        laneId,
        recordingsDir,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (result.deletedUdid || result.detachedUdid || result.removedRecordings || result.removedDerivedData) {
    input.logger.info("lane.end.apple_device_released", { laneId, ...result });
  }
  return result;
}

/** Where `ade apple` builds and tests put DerivedData for one build root (a lane worktree). */
export function appleLaneDerivedDataPath(buildRoot: string): string {
  return path.join(buildRoot, ".ade", "cache", "ios-simulator", "DerivedData");
}
