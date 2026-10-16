/**
 * Reading the account-scoped harness preset list off this machine.
 *
 * A file read (`accountSettingsCacheFile.ts`), not a handle on the store.
 *
 * It lives apart from `harnessPresetLaunch.ts` because the *cleanup* side
 * (`harnessPresetConfigHomes.ts`) needs the same list to decide which private
 * homes a removed credential leaves behind, and importing the launch module
 * from the cleanup module would close a load-time cycle.
 */

import {
  HARNESS_PRESETS_SETTING_KEY,
  normalizeHarnessPresetList,
  type HarnessPreset,
} from "../../../shared/harnessPresets";
import { accountSettingsCacheValue, readAccountSettingsCacheRows } from "../account/accountSettingsCacheFile";

const ACCOUNT_SETTINGS_PRESET_SCOPE = "all";

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
  const rows = readAccountSettingsCacheRows(adeHome);
  if (!rows) return null;
  return normalizeHarnessPresetList(accountSettingsCacheValue(rows, ACCOUNT_SETTINGS_PRESET_SCOPE, HARNESS_PRESETS_SETTING_KEY));
}

/** The same read for callers that treat "cannot answer" and "none" alike. */
export function readHarnessPresetsOrEmpty(adeHome: string): HarnessPreset[] {
  return readHarnessPresetsFromMachine(adeHome) ?? [];
}
