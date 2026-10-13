/**
 * Reading the account settings cache straight off this machine's disk.
 *
 * Deliberately a file read rather than a handle on `AccountSettingsStore`: the
 * store is built by the runtime lifecycle with a relay and a timer, and a chat
 * launch that had to construct one would either start a network sync or fail
 * where the cache alone answers. Every write goes through the same file, so a
 * read here sees the same value the store would return.
 */

import fs from "node:fs";
import path from "node:path";

const ACCOUNT_SETTINGS_CACHE_FILE = "account-settings.json";
/**
 * The on-disk name of the settings cache's row map.
 *
 * `createAccountCacheStore` writes its rows under a per-store field name, and
 * the settings store names that field `settings` (the vault names its own
 * `items`). Reading the in-memory name `rows` finds nothing, which is
 * indistinguishable from "this account has no such setting". The seam test in
 * `harnessPresetLaunch.test.ts` writes through the real settings store, so the
 * two names cannot drift apart again without a red test.
 */
const ACCOUNT_SETTINGS_ROWS_FIELD = "settings";
/** The settings cache keys `<scope>` and `<key>` with a NUL, which neither can contain. */
const ACCOUNT_SETTINGS_KEY_SEPARATOR = "\u0000";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * Every cached row, or `null` when this machine cannot answer.
 *
 * WHY the null: an unreadable or unparsable cache is *not* "this account has
 * no settings". A caller that deletes state on the strength of the answer
 * would erase it the first time the file was mid-write, unreadable, or written
 * by a newer shape.
 */
export function readAccountSettingsCacheRows(adeHome: string): Record<string, unknown> | null {
  let raw: string;
  try {
    raw = fs.readFileSync(path.join(adeHome, ACCOUNT_SETTINGS_CACHE_FILE), "utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  const rows = parsed[ACCOUNT_SETTINGS_ROWS_FIELD];
  return isRecord(rows) ? rows : null;
}

/** One setting's value out of the rows, or `undefined` when there is no such row. */
export function accountSettingsCacheValue(rows: Record<string, unknown>, scope: string, key: string): unknown {
  const row = rows[`${scope}${ACCOUNT_SETTINGS_KEY_SEPARATOR}${key}`];
  return isRecord(row) ? row.value : undefined;
}
