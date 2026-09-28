import type { AppleLaneDevice, AppleLaneDeviceOrigin } from "../../../shared/types/iosSimulator";

/**
 * The `lane_apple_devices` rows: one device per lane, on this Mac only.
 *
 * The table is local-only (never a CRR): a udid names a device inside one
 * Mac's CoreSimulator set. Shared by the registry, which owns the binding, and
 * the lane-end release, which runs in hosts with no simulator service.
 */

export const LANE_APPLE_DEVICES_TABLE = "lane_apple_devices" as const;

/** The slice of `AdeDb` the lane-device code needs. Narrow so tests need no database. */
export type LaneDeviceStore = {
  run: (sql: string, params?: Array<string | number | null>) => void;
  get: <T extends Record<string, unknown> = Record<string, unknown>>(sql: string, params?: Array<string | number | null>) => T | null;
  all: <T extends Record<string, unknown> = Record<string, unknown>>(sql: string, params?: Array<string | number | null>) => T[];
  getJson: <T = unknown>(key: string) => T | null;
  setJson: (key: string, value: unknown) => void;
};

export type LaneDeviceRow = {
  lane_id: string;
  udid: string;
  name: string;
  origin: string;
  family: string;
  runtime: string;
  created_at: string;
  ade_installed_bundle_ids?: string | null;
};

export const LANE_DEVICE_COLUMNS = "lane_id, udid, name, origin, family, runtime, created_at";

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

export function rowToDevice(row: LaneDeviceRow): AppleLaneDevice {
  return {
    laneId: row.lane_id,
    udid: row.udid,
    name: row.name,
    origin: rowOrigin(row.origin),
    family: row.family === "ipad" || row.family === "watch" ? row.family : "iphone",
    runtime: row.runtime,
    createdAt: row.created_at,
  };
}

/** The JSON array in `ade_installed_bundle_ids`; a bad value reads as empty. */
function parseInstalledBundleIds(value: string | null | undefined): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string" && entry.length > 0) : [];
  } catch {
    return [];
  }
}

/**
 * The lane's bound device, straight from `lane_apple_devices` — one indexed
 * row read, never `simctl`.
 *
 * Standalone so a host that never built the simulator service can still ask
 * which device a lane owns: the chat send path reads it to tell the agent about
 * the lane's device. Throws on a store error; callers decide whether that is
 * fatal.
 */
export function readLaneAppleDevice(
  store: Pick<LaneDeviceStore, "get">,
  laneId: string,
): AppleLaneDevice | null {
  return readLaneAppleDeviceRecord(store, laneId)?.device ?? null;
}

/** The lane's device and the bundle ids ADE installed on it (attached devices only). */
export function readLaneAppleDeviceRecord(
  store: Pick<LaneDeviceStore, "get">,
  laneId: string,
): { device: AppleLaneDevice; adeInstalledBundleIds: string[] } | null {
  const trimmed = laneId.trim();
  if (!trimmed) return null;
  const row = store.get<LaneDeviceRow>(
    `select ${LANE_DEVICE_COLUMNS}, ade_installed_bundle_ids from ${LANE_APPLE_DEVICES_TABLE} where lane_id = ?`,
    [trimmed],
  );
  return row ? { device: rowToDevice(row), adeInstalledBundleIds: parseInstalledBundleIds(row.ade_installed_bundle_ids) } : null;
}

/**
 * Does a lane OTHER than `laneId` hold this udid?
 *
 * One udid bound to two lanes should be impossible and has happened. When it
 * has, ending one lane must not delete or power off the device the other lane
 * is using: the ending lane only lets go of its row.
 */
export function anotherLaneHoldsUdid(store: Pick<LaneDeviceStore, "get">, udid: string, laneId: string): boolean {
  return Boolean(store.get<{ one: number }>(
    `select 1 as one from ${LANE_APPLE_DEVICES_TABLE} where udid = ? and lane_id != ? limit 1`,
    [udid, laneId],
  ));
}

/** Save the apps ADE installed on an attached lane device. */
export function writeAdeInstalledBundleIds(
  store: Pick<LaneDeviceStore, "run">,
  laneId: string,
  udid: string,
  bundleIds: readonly string[],
): void {
  store.run(
    `update ${LANE_APPLE_DEVICES_TABLE} set ade_installed_bundle_ids = ? where lane_id = ? and udid = ?`,
    [JSON.stringify([...bundleIds]), laneId, udid],
  );
}

/**
 * Drop one lane's row, keyed by lane AND udid: a new device the lane got in
 * the meantime (an unarchive) is never the row removed.
 */
export function forgetLaneDeviceRow(store: Pick<LaneDeviceStore, "run">, laneId: string, udid: string): void {
  store.run(`delete from ${LANE_APPLE_DEVICES_TABLE} where lane_id = ? and udid = ?`, [laneId, udid]);
}
