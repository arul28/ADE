import type { AndroidLaneDevice } from "../../../shared/types/androidEmulator";

/**
 * The `lane_android_devices` rows: one AVD per lane, on this machine only.
 *
 * The table is local-only (never a CRR): an AVD name means a folder in one
 * machine's AVD home, so a replicated row would tell a second machine or a
 * phone that a lane owns an emulator it cannot see. A sibling of
 * `lane_apple_devices`, not a column on it: a udid and a runtime mean nothing
 * for an AVD.
 */

const LANE_ANDROID_DEVICES_TABLE = "lane_android_devices" as const;

/** The slice of `AdeDb` the store needs. Narrow so tests need no database. */
export type AndroidLaneDeviceStore = {
  run: (sql: string, params?: Array<string | number | null>) => void;
  get: <T extends Record<string, unknown> = Record<string, unknown>>(sql: string, params?: Array<string | number | null>) => T | null;
};

type AndroidLaneDeviceRow = {
  lane_id: string;
  avd_name: string;
  origin: string;
  profile_id: string | null;
  system_image: string | null;
  created_at: string;
  ade_installed_packages: string | null;
};

const COLUMNS = "lane_id, avd_name, origin, profile_id, system_image, created_at, ade_installed_packages";

/** The JSON array in `ade_installed_packages`; a bad value reads as empty. */
function parsePackages(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string" && entry.length > 0) : [];
  } catch {
    return [];
  }
}

function rowToDevice(row: AndroidLaneDeviceRow): AndroidLaneDevice {
  return {
    laneId: row.lane_id,
    avdName: row.avd_name,
    // Only `attached` is the user's. An unknown value from a newer ADE reads
    // as ADE's, so it is still cleaned up with its lane, not kept forever.
    origin: row.origin === "attached" ? "attached" : "created",
    profileId: row.profile_id,
    systemImage: row.system_image,
    createdAt: row.created_at,
    adeInstalledPackages: parsePackages(row.ade_installed_packages),
  };
}

/** The lane's AVD, one indexed row read. Throws on a store error. */
export function readLaneAndroidDevice(store: Pick<AndroidLaneDeviceStore, "get">, laneId: string): AndroidLaneDevice | null {
  const trimmed = laneId.trim();
  if (!trimmed) return null;
  const row = store.get<AndroidLaneDeviceRow>(`select ${COLUMNS} from ${LANE_ANDROID_DEVICES_TABLE} where lane_id = ?`, [trimmed]);
  return row ? rowToDevice(row) : null;
}

/** Binds an AVD to a lane, replacing any row the lane had. */
export function writeLaneAndroidDevice(store: Pick<AndroidLaneDeviceStore, "run">, device: AndroidLaneDevice): void {
  store.run(
    `insert into ${LANE_ANDROID_DEVICES_TABLE} (${COLUMNS}) values (?, ?, ?, ?, ?, ?, ?)
     on conflict(lane_id) do update set avd_name = excluded.avd_name, origin = excluded.origin,
       profile_id = excluded.profile_id, system_image = excluded.system_image,
       created_at = excluded.created_at, ade_installed_packages = excluded.ade_installed_packages`,
    [
      device.laneId,
      device.avdName,
      device.origin,
      device.profileId,
      device.systemImage,
      device.createdAt,
      JSON.stringify([...device.adeInstalledPackages]),
    ],
  );
}

/**
 * Drops one lane's row, keyed by lane AND AVD: a new AVD the lane got in the
 * meantime is never the row removed.
 */
export function forgetLaneAndroidDevice(store: Pick<AndroidLaneDeviceStore, "run">, laneId: string, avdName: string): void {
  store.run(`delete from ${LANE_ANDROID_DEVICES_TABLE} where lane_id = ? and avd_name = ?`, [laneId, avdName]);
}

/**
 * The lane that holds this AVD, other than `exceptLaneId`. One AVD boots once
 * at a time, so two lanes must never share one; ending one lane must not stop
 * or delete the AVD another lane is using. Names compare case-insensitively,
 * as the emulator's AVD lookup does on Windows and macOS.
 */
export function laneHoldingAndroidAvd(
  store: Pick<AndroidLaneDeviceStore, "get">,
  avdName: string,
  exceptLaneId: string | null = null,
): string | null {
  const row = exceptLaneId
    ? store.get<{ lane_id: string }>(
      `select lane_id from ${LANE_ANDROID_DEVICES_TABLE} where lower(avd_name) = lower(?) and lane_id != ? limit 1`,
      [avdName, exceptLaneId],
    )
    : store.get<{ lane_id: string }>(
      `select lane_id from ${LANE_ANDROID_DEVICES_TABLE} where lower(avd_name) = lower(?) limit 1`,
      [avdName],
    );
  return row?.lane_id ?? null;
}

/** Drops every row of one lane, whatever AVD it names. */
export function forgetLaneAndroidDevices(store: Pick<AndroidLaneDeviceStore, "run">, laneId: string): void {
  store.run(`delete from ${LANE_ANDROID_DEVICES_TABLE} where lane_id = ?`, [laneId]);
}

/** Hands one lane's row to another lane (a lane merge). */
export function moveLaneAndroidDevice(store: Pick<AndroidLaneDeviceStore, "run">, fromLaneId: string, toLaneId: string): void {
  store.run(`update ${LANE_ANDROID_DEVICES_TABLE} set lane_id = ? where lane_id = ?`, [toLaneId, fromLaneId]);
}
