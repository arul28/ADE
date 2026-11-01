import {
  normalizeHarnessPresetList,
  unreadableHarnessPresetEntries,
  type HarnessPreset,
} from "../../shared/harnessPresets";

/**
 * Presets a newer ADE synced that this build cannot read. They are not shown
 * or launched here, but every write of the list (to disk and to the account)
 * carries them, so editing another preset on this machine never deletes them.
 */
let unreadable: unknown[] = [];

/** Read a stored or synced list: this build's presets, setting aside the rows it cannot read. */
export function readHarnessPresetList(value: unknown): HarnessPreset[] {
  unreadable = unreadableHarnessPresetEntries(value);
  return normalizeHarnessPresetList(value);
}

/** The list to store or sync: this build's presets plus the ones it cannot read. */
export function withUnreadableHarnessPresets(presets: readonly HarnessPreset[]): unknown[] {
  if (unreadable.length === 0) return [...presets];
  const ids = new Set(presets.map((preset) => preset.id));
  return [
    ...presets,
    ...unreadable.filter((entry) => !ids.has(String((entry as { id?: unknown }).id).trim())),
  ];
}
