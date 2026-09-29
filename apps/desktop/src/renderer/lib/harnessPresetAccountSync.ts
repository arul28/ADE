/**
 * The two moments a Custom provider must already be on the brain.
 *
 * A preset is an account-scoped preference, so it is saved locally and reaches
 * the brain on the next sync tick. The brain is also what *resolves* a launch —
 * it reads the very same `account-settings.json` — so a save immediately
 * followed by a launch, or a launch on a machine whose tick has not run, reads
 * a list the preset is not in yet and reports "this harness preset no longer
 * exists on this account" while the chat quietly falls back to the harness's
 * own sign-in.
 *
 * Both entry points therefore go through here:
 *
 * - {@link saveHarnessPresetsToAccount} — a save reports success only once the
 *   brain has confirmed the write, so the dialog can say so when it has not.
 * - {@link ensureHarnessPresetOnBrain} — a launch that names a saved preset
 *   checks the machine's copy first and pushes this machine's list when the
 *   preset is missing, before the runtime that owns the lane resolves it.
 *
 * Both are best-effort by contract: an unavailable brain must never fail a
 * launch. The launch keeps the same honest degradation it always had.
 */

import {
  HARNESS_PRESETS_SETTING_KEY,
  normalizeHarnessPresetList,
} from "../../shared/harnessPresets";
import { isRoutePresetId } from "../../shared/harnessRoutes";
import { rootAppStoreApi } from "../state/appStore";
import { flushAccountSettingKey } from "./accountSettingsFlush";

export type HarnessPresetAccountSyncOutcome = {
  /** False when the brain could not be reached or refused the write. */
  ok: boolean;
  /** One sentence for the user, or null when there is nothing to say. */
  message: string | null;
};

function accountSettingsApi(): NonNullable<typeof window.ade.accountSettings> | null {
  return window.ade?.accountSettings ?? null;
}

function presetIdsFromRow(value: unknown): string[] | null {
  const presets = normalizeHarnessPresetList(value);
  return presets.map((preset) => preset.id);
}

/**
 * Whether this machine's settings cache already holds the preset.
 *
 * `null` means the question could not be answered (no bridge, no brain, an
 * unreadable row) — distinct from `false`, which is a confirmed absence.
 */
async function machineHoldsPreset(presetId: string): Promise<boolean | null> {
  const api = accountSettingsApi();
  if (!api) return null;
  try {
    const result = await api.list({ scope: "all" });
    if (!result || result.ok !== true) return null;
    const row = result.value.find((entry) => entry.key === HARNESS_PRESETS_SETTING_KEY);
    if (!row) return false;
    const ids = presetIdsFromRow(row.value);
    return ids ? ids.includes(presetId) : null;
  } catch {
    return null;
  }
}

/**
 * Write this machine's preset list to the brain and await the confirmation.
 *
 * Caller rule: the store has already been updated, so the local copy is never
 * in doubt — this answers only whether the account has it too.
 */
export async function saveHarnessPresetsToAccount(): Promise<HarnessPresetAccountSyncOutcome> {
  const result = await flushAccountSettingKey(HARNESS_PRESETS_SETTING_KEY);
  if (result.ok) return { ok: true, message: null };
  return { ok: false, message: result.message };
}

/**
 * Make sure the brain holds this preset before something reads it out of there.
 *
 * A route id (`route.<…>`) needs nothing: it carries the whole launch spec in
 * its own id. A preset id does, and a confirmed absence is the one case worth a
 * write — the common case costs a single cached read.
 *
 * Never throws and never blocks a launch on a failure: `ok: false` says only
 * that the launch may not find the preset, which is the state it was already in.
 */
export async function ensureHarnessPresetOnBrain(
  presetId: string | null | undefined,
): Promise<HarnessPresetAccountSyncOutcome> {
  const id = presetId?.trim() ?? "";
  if (!id || isRoutePresetId(id)) return { ok: true, message: null };
  // Read the list here rather than taking it as an argument: every launch
  // surface would otherwise have to thread the store's slice through for a
  // check that is about this machine's saved list, not about the caller.
  const presets = rootAppStoreApi.getState().harnessPresets;
  if (!presets.some((preset) => preset.id === id)) {
    // Not this machine's list either — a stale chat, or another account's
    // preset. Say so rather than pushing a list that cannot contain it.
    return { ok: false, message: "This custom provider is not saved on this computer." };
  }
  const present = await machineHoldsPreset(id);
  if (present !== false) return { ok: true, message: null };
  return await saveHarnessPresetsToAccount();
}
