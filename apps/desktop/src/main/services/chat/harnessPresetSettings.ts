/**
 * Reading the account-scoped harness preset list off this machine.
 *
 * Deliberately a file read rather than a handle on `AccountSettingsStore`: the
 * store is built by the runtime lifecycle with a relay and a timer, and a
 * launch that had to construct one would either start a network sync or fail
 * where the cache alone answers. Every write goes through the same file, so a
 * read here sees the same value the store would return.
 *
 * It lives apart from `harnessPresetLaunch.ts` because the *cleanup* side
 * (`harnessPresetConfigHomes.ts`) needs the same list to decide which private
 * homes a removed credential leaves behind, and importing the launch module
 * from the cleanup module would close a load-time cycle.
 */

import fs from "node:fs";
import path from "node:path";

import { normalizeHarnessPresetList, type HarnessPreset } from "../../../shared/harnessPresets";

const ACCOUNT_SETTINGS_CACHE_FILE = "account-settings.json";
/**
 * The on-disk name of the settings cache's row map.
 *
 * `createAccountCacheStore` writes its rows under a per-store field name, and
 * the settings store names that field `settings` (the vault names its own
 * `items`). Reading the in-memory name `rows` finds nothing, which is
 * indistinguishable from "this account has no presets" and silently drops every
 * preset launch back to the provider default. The seam test in
 * `harnessPresetLaunch.test.ts` writes through the real settings store, so the
 * two names cannot drift apart again without a red test.
 */
const ACCOUNT_SETTINGS_ROWS_FIELD = "settings";
const ACCOUNT_SETTINGS_PRESET_SCOPE = "all";
const ACCOUNT_SETTINGS_PRESET_KEY = "harnessPresets";
/** The settings cache keys `<scope>` and `<key>` with a NUL, which neither can contain. */
const ACCOUNT_SETTINGS_KEY_SEPARATOR = "\u0000";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * The preset list, or `null` when this machine cannot answer.
 *
 * WHY the null: an unreadable or unparsable cache is *not* "this account has no
 * presets". Callers that delete state on the strength of the answer — the
 * orphaned-home pruner above all — would erase every live preset's private
 * config home the first time the file was mid-write, unreadable, or written by
 * a newer shape. A confirmed empty list (the cache parsed and holds no preset
 * row) still returns `[]`, so a genuine "all presets deleted" still prunes.
 */
export function readHarnessPresetsFromMachine(adeHome: string): HarnessPreset[] | null {
  const cachePath = path.join(adeHome, ACCOUNT_SETTINGS_CACHE_FILE);
  let raw: string;
  try {
    raw = fs.readFileSync(cachePath, "utf8");
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
  if (!isRecord(rows)) return null;
  const composite = `${ACCOUNT_SETTINGS_PRESET_SCOPE}${ACCOUNT_SETTINGS_KEY_SEPARATOR}${ACCOUNT_SETTINGS_PRESET_KEY}`;
  const row = rows[composite];
  return normalizeHarnessPresetList(isRecord(row) ? row.value : undefined);
}

/** The same read for callers that treat "cannot answer" and "none" alike. */
export function readHarnessPresetsOrEmpty(adeHome: string): HarnessPreset[] {
  return readHarnessPresetsFromMachine(adeHome) ?? [];
}
