import type { CloudDb } from "./store";

/**
 * Instant server switches (rows of `cloud_settings`, beside the server's own keys): the owner flips
 * one with the account test tool (`POST /cloud/owner/settings`,
 * `scripts/cloud-owner.mjs`) and the next request reads it, no deploy.
 *
 * A switch with a deploy variable is held under it: the variable is the
 * highest the switch may go (`off` there is a hard off whatever the row
 * says). A switch with no row reads its first value, which is always off.
 */
export const CLOUD_SETTINGS = {
  /** Sponsored cards and the Index (`gravity.ts`); held under `GRAVITY_ADS`. */
  gravity_ads: ["off", "testers", "all"],
  /** Real ads and real Index picks instead of Gravity's test ads; held under `GRAVITY_LIVE` (`1`). */
  gravity_live: ["off", "on"],
  /** Free's Small computers use hours unless the account shows sponsored cards (`smallRate.ts`). */
  free_small_needs_ads: ["off", "on"],
} as const satisfies Record<string, readonly [string, ...string[]]>;

export type CloudSettingKey = keyof typeof CLOUD_SETTINGS;
export type CloudSettingValue<K extends CloudSettingKey> = (typeof CLOUD_SETTINGS)[K][number];
export type CloudSettings = { [K in CloudSettingKey]: CloudSettingValue<K> };

export const isCloudSettingKey = (value: unknown): value is CloudSettingKey =>
  typeof value === "string" && Object.prototype.hasOwnProperty.call(CLOUD_SETTINGS, value);

export function isCloudSettingValue<K extends CloudSettingKey>(key: K, value: unknown): value is CloudSettingValue<K> {
  return typeof value === "string" && (CLOUD_SETTINGS[key] as readonly string[]).includes(value);
}

/** Every switch as stored, each missing or unknown one at its first value (off). One read. */
export async function readCloudSettings(env: CloudDb): Promise<CloudSettings> {
  const rows = await env.DB.prepare("select key, value from cloud_settings where key in (select value from json_each(?))")
    .bind(JSON.stringify(Object.keys(CLOUD_SETTINGS))).all<{ key: string; value: string }>();
  const stored = new Map((rows.results ?? []).map((row) => [row.key, row.value]));
  const settings = {} as Record<CloudSettingKey, string>;
  for (const key of Object.keys(CLOUD_SETTINGS) as CloudSettingKey[]) {
    const value = stored.get(key);
    settings[key] = isCloudSettingValue(key, value) ? value : CLOUD_SETTINGS[key][0];
  }
  return settings as CloudSettings;
}

/** When a switch last changed, or null for one never set. */
export async function settingChangedAt(env: CloudDb, key: CloudSettingKey): Promise<number | null> {
  const row = await env.DB.prepare("select updated_at from cloud_settings where key = ?").bind(key).first<{ updated_at: number }>();
  return row?.updated_at ?? null;
}

/** `value`, held under `ceiling` (both in the switch's own order): the lower of the two. */
export function heldUnder<K extends CloudSettingKey>(key: K, value: CloudSettingValue<K>, ceiling: CloudSettingValue<K>): CloudSettingValue<K> {
  const order = CLOUD_SETTINGS[key] as readonly string[];
  return order.indexOf(value) <= order.indexOf(ceiling) ? value : ceiling;
}

/** Writes one switch and its change log row in one batch. */
export async function writeCloudSetting<K extends CloudSettingKey>(env: CloudDb, key: K, value: CloudSettingValue<K>, note: string | null, now: number): Promise<void> {
  await env.DB.batch([
    // `updated_at` is when the value last changed (a re-ask keys on it): writing the same value again keeps it.
    env.DB.prepare(`
      insert into cloud_settings (key, value, updated_at) values (?, ?, ?)
      on conflict (key) do update set value = excluded.value, updated_at = excluded.updated_at where cloud_settings.value <> excluded.value
    `).bind(key, value, now),
    ownerLogStatement(env, now, "setting", null, { key, value, note }),
  ]);
}

/** One row of the owner's change log: every switch and account test change. */
export function ownerLogStatement(env: CloudDb, now: number, action: string, userId: string | null, detail: Record<string, unknown>): D1PreparedStatement {
  return env.DB.prepare("insert into cloud_owner_log (at, action, user_id, detail) values (?, ?, ?, ?)")
    .bind(now, action, userId, JSON.stringify(detail));
}
