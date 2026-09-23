import os from "node:os";
import path from "node:path";
import { appleRecordingsDirectory } from "./recording/appleRecordingsStore";
import { bareSimulatorPowerOff } from "./simulatorPower";

import type {
  AppleDeviceDiskUsage,
  AppleDeviceListResult,
  AppleInstalledSimulator,
  AppleLaneDevice,
  AppleLaneDeviceFamily,
  AppleSimulatorOwner,
} from "../../../shared/types/iosSimulator";
import {
  APPLE_DEVICE_ATTACHED_NOT_DELETABLE_CODE,
  APPLE_DEVICE_EXISTS_CODE,
  APPLE_DEVICE_OWNED_BY_LANE_CODE,
  APPLE_TEMPLATE_BOOTED_CODE,
  APPLE_NO_INSTALLED_SIMULATORS_CODE,
} from "../../../shared/types/iosSimulator";

/**
 * One simulator per lane, many per machine.
 *
 * A lane gets no device until it is asked for. The first ask clones the
 * project's last-used installed simulator (else the newest installed iPhone)
 * with `simctl clone` and names the clone for the lane, so two lanes never
 * share a screen and a lane's device is recognisable in Xcode's own device
 * list. A lane may instead ATTACH an existing simulator, which binds without
 * cloning — and which is why delete has two behaviours: ADE deletes what it
 * created and never deletes what it did not.
 *
 * ADE never downloads a runtime. `simctl` will happily fetch several gigabytes
 * for a runtime that is merely *known*; a lane asking for a device must not
 * start that, so every template comes from the installed list and an empty list
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

  constructor(
    readonly device: AppleLaneDevice,
    hint = `Pass force to detach it from lane ${device.laneId} instead.`,
  ) {
    super(`${APPLE_DEVICE_ATTACHED_NOT_DELETABLE_CODE}: ${device.name} was attached, not created by ADE, so ADE will not delete it. ${hint}`);
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

export class AppleTemplateBootedError extends Error {
  readonly code = APPLE_TEMPLATE_BOOTED_CODE;

  constructor(readonly template: AppleInstalledSimulator) {
    super(`${APPLE_TEMPLATE_BOOTED_CODE}: ${template.name} (${template.udid}) is running, and simctl cannot clone a booted device. Power it off, or name a stopped simulator to copy from.`);
    this.name = "AppleTemplateBootedError";
  }
}

export const LANE_APPLE_DEVICES_TABLE = "lane_apple_devices" as const;
/** KV key holding the project's last-used template, per the contracts file. */
export const APPLE_LAST_TEMPLATE_KEY = "apple:last-template-udid" as const;

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

export type LaneDeviceRegistry = {
  deviceCreate(args: { laneId: string; from?: string | null; name?: string | null }): Promise<AppleLaneDevice>;
  /**
   * Bind an installed simulator to a lane.
   *
   * Three outcomes, and exactly one lane owns the device after all of them:
   * the lane already holds it (answered as-is), nobody holds it (a plain
   * attach), or another lane holds it (the binding MOVES — see `rebind`).
   */
  deviceAttach(args: { laneId: string; simulator: string }): Promise<AppleLaneDevice>;
  deviceList(args?: {
    installed?: boolean | null;
    laneId?: string | null;
    disk?: boolean | null;
  }): Promise<AppleDeviceListResult>;
  /**
   * Delete the lane's clone. An attached device is always refused: ADE never
   * deletes a simulator it did not create. Detaching one is `deviceDetach`.
   */
  deviceDelete(args: { laneId: string }): Promise<void>;
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

/**
 * The template a fresh lane device is cloned from.
 *
 * Order is the locked one from the spec: an explicit `--from`, then the
 * project's last-used installed simulator, then the newest installed iPhone.
 * Exported pure so the precedence is testable without `simctl`.
 */
export function pickAppleTemplate(input: {
  installed: AppleInstalledSimulator[];
  from?: string | null;
  lastUsedUdid?: string | null;
}): AppleInstalledSimulator | null {
  const installed = input.installed.filter((device) => device.isAvailable);
  if (!installed.length) return null;
  const from = input.from?.trim();
  if (from) {
    // An explicitly named template is the caller's choice, booted or not. The
    // clone will fail if it is booted, and `create` says so by name.
    return installed.find((device) => device.udid === from)
      ?? installed.find((device) => device.name === from)
      ?? installed.find((device) => device.name.toLowerCase() === from.toLowerCase())
      ?? null;
  }
  /*
   * `simctl clone` cannot copy a BOOTED device — it fails with "Unable to
   * clone device in current state: Booted" (error 405). Nothing here looked at
   * state, so on a Mac whose newest iPhone happened to be running, every
   * automatic pick chose the one device that could not be cloned, and
   * `open-device` failed with a raw simctl error. Found by an agent testing
   * the flow.
   *
   * Booted devices stay in the pool as a last resort so the caller gets the
   * named error below rather than "no simulators installed", which would be
   * false.
   */
  const cloneable = installed.filter((device) => device.state !== "Booted");
  const candidates = cloneable.length ? cloneable : installed;
  const lastUsed = input.lastUsedUdid?.trim();
  if (lastUsed) {
    const match = candidates.find((device) => device.udid === lastUsed);
    if (match) return match;
  }
  const phones = candidates.filter((device) => device.family === "iphone");
  const pool = phones.length ? phones : candidates;
  return [...pool].sort((a, b) => {
    const byRuntime = appleRuntimeScore(b.runtime) - appleRuntimeScore(a.runtime);
    if (byRuntime !== 0) return byRuntime;
    return a.name.localeCompare(b.name);
  })[0] ?? null;
}

/**
 * The clone's name.
 *
 * `ADE · <lane>` is the locked pattern: the separator makes an ADE clone
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

function rowToDevice(row: LaneDeviceRow): AppleLaneDevice {
  return {
    laneId: row.lane_id,
    udid: row.udid,
    name: row.name,
    origin: row.origin === "attached" ? "attached" : "clone",
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

  const rememberTemplate = (udid: string): void => {
    try {
      deps.store?.setJson(APPLE_LAST_TEMPLATE_KEY, udid);
    } catch (error) {
      deps.logger.debug("apple.template_remember_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const lastTemplate = (): string | null => {
    try {
      const value = deps.store?.getJson<string>(APPLE_LAST_TEMPLATE_KEY);
      return typeof value === "string" && value.trim() ? value.trim() : null;
    } catch {
      return null;
    }
  };

  /**
   * The lane's display name, for the clone's name.
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

  const create = async (args: { laneId: string; from?: string | null; name?: string | null }): Promise<AppleLaneDevice> => {
    const laneId = requireLaneId(args.laneId);
    const existing = readOne(laneId);
    if (existing) throw new AppleDeviceExistsError(existing);
    const installed = await deps.listInstalledSimulators();
    const template = pickAppleTemplate({ installed, from: args.from, lastUsedUdid: lastTemplate() });
    if (!template) {
      if (args.from?.trim() && installed.length) {
        throw new Error(`No installed simulator matches ${args.from.trim()}. Run device-list --installed to see what this Mac has.`);
      }
      throw new AppleNoInstalledSimulatorsError();
    }
    /*
     * Reached when every installed simulator is booted, or when the caller
     * named a booted one. `simctl clone` fails on a booted device with a bare
     * "Unable to clone device in current state: Booted", which tells the reader
     * nothing about what to do next.
     */
    if (template.state === "Booted") throw new AppleTemplateBootedError(template);
    const name = appleLaneDeviceName({
      laneId,
      laneName: laneNameFor(laneId),
      requested: args.name,
      taken: installed.map((device) => device.name),
    });
    // `simctl clone` prints the new udid and nothing else. Anything on stderr
    // is a warning, not the answer, which is why only stdout is parsed.
    const { stdout } = await deps.run("xcrun", ["simctl", "clone", template.udid, name], { timeoutMs: 120_000 });
    const udid = stdout.trim().split(/\s+/).filter(Boolean).pop() ?? "";
    if (!udid) {
      throw new Error(`simctl clone did not report a udid for ${name}. Check \`xcrun simctl list devices\` and try again.`);
    }
    const device: AppleLaneDevice = {
      laneId,
      udid,
      name,
      origin: "clone",
      family: template.family,
      runtime: template.runtime,
      createdAt: now().toISOString(),
      templateUdid: template.udid,
    };
    write(device);
    rememberTemplate(template.udid);
    deps.logger.info("apple.lane_device_created", { laneId, udid, name, templateUdid: template.udid });
    return device;
  };

  const attach = async (args: { laneId: string; simulator: string }): Promise<AppleLaneDevice> => {
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

  const remove = async (args: { laneId: string }): Promise<void> => {
    const laneId = requireLaneId(args.laneId);
    const device = readOne(laneId);
    if (!device) return;
    // ADE does not delete a simulator it did not create: a user's own device
    // being erased because a lane was archived is not a recoverable mistake.
    if (device.origin === "attached") throw new AppleDeviceAttachedNotDeletableError(device);
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

  return {
    deviceCreate: create,
    deviceAttach: attach,
    deviceDeleteInstalled: removeInstalled,
    async deviceList(args = {}) {
      const wantInstalled = args.installed !== false;
      const installed = wantInstalled ? await deps.listInstalledSimulators() : [];
      const laneId = args.laneId?.trim() || null;
      return {
        installed,
        lane: laneId ? readOne(laneId) : null,
        owners: ownersFor(laneId),
        laneId,
        disk: args.disk ? await measureDisk() : null,
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
  };
}

/**
 * Everything a deleted or archived lane owns on the Apple side.
 *
 * Called from `laneService`'s delete cascade, right next to
 * `removeLaneArtifactFiles`, and deliberately standalone rather than a method
 * on the simulator service: lane deletion runs in hosts that never constructed
 * one (the headless brain with `--chat-only`, the reap-vanished-worktrees
 * sweep), and a lane whose clone survived because no service happened to be
 * alive is a simulator nobody will ever delete.
 *
 * Two rules, both from the spec and both load-bearing:
 *
 * - A `clone` is ADE's and is deleted. An `attached` device is the user's and
 *   is only ever detached — ADE never deletes a simulator it did not create.
 * - Failures are logged, never thrown. This runs inside a delete that has
 *   already removed the worktree; aborting it would leave the lane half-gone.
 *
 * Fire-and-forget by design: the caller does not await it, because a
 * `simctl delete` can take tens of seconds on a large device set and the lane
 * row is already gone.
 */
export async function releaseLaneAppleDevice(input: {
  laneId: string;
  projectRoot: string;
  store: Pick<LaneDeviceStore, "get" | "run">;
  run: RunCommand;
  removeDirectory: (directory: string) => Promise<void>;
  logger: {
    info: (event: string, data?: Record<string, unknown>) => void;
    warn: (event: string, data?: Record<string, unknown>) => void;
  };
}): Promise<{ deletedUdid: string | null; detachedUdid: string | null; removedRecordings: boolean }> {
  const laneId = input.laneId.trim();
  const result = { deletedUdid: null as string | null, detachedUdid: null as string | null, removedRecordings: false };
  if (!laneId) return result;

  let row: LaneDeviceRow | null = null;
  try {
    row = input.store.get<LaneDeviceRow>(
      `select lane_id, udid, name, origin, family, runtime, created_at, template_udid from ${LANE_APPLE_DEVICES_TABLE} where lane_id = ?`,
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
    if (device.origin === "clone" && process.platform === "darwin") {
      // Powered off first, as `remove` does, through the same power path.
      await bareSimulatorPowerOff(input.run)(device.udid).catch(() => false);
      try {
        await input.run("xcrun", ["simctl", "delete", device.udid], { timeoutMs: 120_000 });
        result.deletedUdid = device.udid;
      } catch (error) {
        input.logger.warn("lane.delete.apple_device_delete_failed", {
          laneId,
          udid: device.udid,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    } else if (device.origin === "attached") {
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

  if (result.deletedUdid || result.detachedUdid || result.removedRecordings) {
    input.logger.info("lane.delete.apple_device_released", { laneId, ...result });
  }
  return result;
}
