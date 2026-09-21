import type {
  AppleInstalledSimulator,
  AppleLaneDevice,
  AppleLaneDeviceFamily,
} from "../../../shared/types/iosSimulator";
import {
  APPLE_DEVICE_ATTACHED_NOT_DELETABLE_CODE,
  APPLE_DEVICE_EXISTS_CODE,
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

  constructor(readonly device: AppleLaneDevice) {
    super(`${APPLE_DEVICE_ATTACHED_NOT_DELETABLE_CODE}: ${device.name} was attached, not created by ADE, so ADE will not delete it. Pass force to detach it from lane ${device.laneId} instead.`);
    this.name = "AppleDeviceAttachedNotDeletableError";
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
  /** Every installed, available simulator on this Mac. */
  listInstalledSimulators: () => Promise<AppleInstalledSimulator[]>;
  /** Human name for a lane, used in the clone's name. Null falls back to the id. */
  resolveLaneName?: ((laneId: string) => string | null) | null;
  /** The lanes DB. Omitted in hosts that have none; the registry then keeps rows in memory. */
  store?: LaneDeviceStore | null;
  logger: {
    info: (event: string, data?: Record<string, unknown>) => void;
    debug: (event: string, data?: Record<string, unknown>) => void;
    warn?: (event: string, data?: Record<string, unknown>) => void;
  };
  now?: () => Date;
};

export type LaneDeviceRegistry = {
  deviceCreate(args: { laneId: string; from?: string | null; name?: string | null }): Promise<AppleLaneDevice>;
  deviceAttach(args: { laneId: string; simulator: string }): Promise<AppleLaneDevice>;
  deviceList(args?: { installed?: boolean | null; laneId?: string | null }): Promise<{
    installed: AppleInstalledSimulator[];
    lane: AppleLaneDevice | null;
  }>;
  deviceDelete(args: { laneId: string; force?: boolean | null }): Promise<void>;
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
    return installed.find((device) => device.udid === from)
      ?? installed.find((device) => device.name === from)
      ?? installed.find((device) => device.name.toLowerCase() === from.toLowerCase())
      ?? null;
  }
  const lastUsed = input.lastUsedUdid?.trim();
  if (lastUsed) {
    const match = installed.find((device) => device.udid === lastUsed);
    if (match) return match;
  }
  const phones = installed.filter((device) => device.family === "iphone");
  const pool = phones.length ? phones : installed;
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
        .all<LaneDeviceRow>(`select lane_id, udid, name, origin, family, runtime, created_at, template_udid from ${LANE_APPLE_DEVICES_TABLE}`)
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
      const row = deps.store.get<LaneDeviceRow>(
        `select lane_id, udid, name, origin, family, runtime, created_at, template_udid from ${LANE_APPLE_DEVICES_TABLE} where lane_id = ?`,
        [trimmed],
      );
      return row ? rowToDevice(row) : null;
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
    if (existing) throw new AppleDeviceExistsError(existing);
    const installed = await deps.listInstalledSimulators();
    if (!installed.length) throw new AppleNoInstalledSimulatorsError();
    const match = installed.find((device) => device.udid === wanted)
      ?? installed.find((device) => device.name === wanted)
      ?? installed.find((device) => device.name.toLowerCase() === wanted.toLowerCase());
    if (!match) {
      throw new Error(`No installed simulator matches ${wanted}. Run device-list --installed to see what this Mac has.`);
    }
    const device: AppleLaneDevice = {
      laneId,
      udid: match.udid,
      name: match.name,
      origin: "attached",
      family: match.family,
      runtime: match.runtime,
      createdAt: now().toISOString(),
      templateUdid: null,
    };
    write(device);
    deps.logger.info("apple.lane_device_attached", { laneId, udid: device.udid, name: device.name });
    return device;
  };

  const remove = async (args: { laneId: string; force?: boolean | null }): Promise<void> => {
    const laneId = requireLaneId(args.laneId);
    const device = readOne(laneId);
    if (!device) return;
    if (device.origin === "attached") {
      // force DETACHES. It never deletes: ADE does not delete a simulator it
      // did not create, and a user's own device being erased because a lane was
      // archived is not a recoverable mistake.
      if (!args.force) throw new AppleDeviceAttachedNotDeletableError(device);
      forget(laneId);
      deps.logger.info("apple.lane_device_detached", { laneId, udid: device.udid });
      return;
    }
    // Shut down first: `simctl delete` on a booted device leaves CoreSimulator
    // holding the data directory and the delete reports success having removed
    // nothing.
    await deps.run("xcrun", ["simctl", "shutdown", device.udid], { timeoutMs: 60_000 }).catch((error: unknown) => {
      deps.logger.debug("apple.lane_device_shutdown_failed", {
        laneId,
        udid: device.udid,
        error: error instanceof Error ? error.message : String(error),
      });
      return { stdout: "", stderr: "" };
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

  return {
    deviceCreate: create,
    deviceAttach: attach,
    async deviceList(args = {}) {
      const wantInstalled = args.installed !== false;
      const installed = wantInstalled ? await deps.listInstalledSimulators() : [];
      const laneId = args.laneId?.trim();
      return { installed, lane: laneId ? readOne(laneId) : null };
    },
    deviceDelete: remove,
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
      // Shut down first: `simctl delete` on a booted device leaves
      // CoreSimulator holding the data directory and reports success having
      // removed nothing.
      await input.run("xcrun", ["simctl", "shutdown", device.udid], { timeoutMs: 60_000 }).catch(() => ({ stdout: "", stderr: "" }));
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

  const recordingsDir = [input.projectRoot, ".ade", "artifacts", "apple-recordings", laneId].join("/");
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
