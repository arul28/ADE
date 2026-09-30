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
  type HarnessPreset,
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

/**
 * The preset as this machine's settings cache holds it, or `null` when the
 * question could not be answered (no bridge, no brain, an unreadable row).
 *
 * The CONTENT, not just the id: the brain resolves the whole preset out of this
 * row, so an edit whose upload failed leaves the id present with the previous
 * model, source and pins — and a guard that matched on the id alone would let
 * that launch run the old settings while the picker showed the new ones.
 */
async function machinePreset(presetId: string): Promise<HarnessPreset | null | undefined> {
  const api = accountSettingsApi();
  if (!api) return null;
  try {
    const result = await api.list({ scope: "all" });
    if (!result || result.ok !== true) return null;
    const row = result.value.find((entry) => entry.key === HARNESS_PRESETS_SETTING_KEY);
    if (!row) return undefined;
    // A row whose value is not a list is a shape this build does not
    // understand — "cannot answer", never "absent". Normalising it would yield
    // an empty list, and pushing on that would replace a list this machine
    // never read.
    if (!Array.isArray(row.value)) return null;
    return normalizeHarnessPresetList(row.value).find((preset) => preset.id === presetId);
  } catch {
    return null;
  }
}

/** The same preset on both sides, compared as stored. */
function samePresetOnBothSides(local: HarnessPreset, machine: HarnessPreset | null): boolean {
  if (!machine) return false;
  try {
    return JSON.stringify(machine) === JSON.stringify(local);
  } catch {
    return false;
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
  options: {
    /**
     * The launch runs on another computer, whose resolver reads THAT machine's
     * settings cache. This client cannot read or write it — the account
     * settings service is local-runtime-backed — so the only honest answer is
     * that this check does not cover that machine's copy.
     */
    targetsAnotherMachine?: boolean;
  } = {},
): Promise<HarnessPresetAccountSyncOutcome> {
  const id = presetId?.trim() ?? "";
  if (!id || isRoutePresetId(id)) return { ok: true, message: null };
  // WHY the catch is here rather than at each call site: every caller treats
  // this as a best-effort step it runs *before* something else, and a throw
  // from it would abort that something else — a launch that skips its own
  // cleanup, a batch whose item never starts. One guarantee, enforced in one
  // place, is what those callers are actually relying on.
  try {
    return await ensureHarnessPresetOnBrainUnchecked(id, options);
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : String(error ?? ""),
    };
  }
}

async function ensureHarnessPresetOnBrainUnchecked(
  id: string,
  options: { targetsAnotherMachine?: boolean },
): Promise<HarnessPresetAccountSyncOutcome> {
  if (options.targetsAnotherMachine) {
    return {
      ok: false,
      message: "This chat runs on another computer, which keeps its own copy of your account settings.",
    };
  }
  // Read the list here rather than taking it as an argument: every launch
  // surface would otherwise have to thread the store's slice through for a
  // check that is about this machine's saved list, not about the caller.
  const presets = rootAppStoreApi.getState().harnessPresets;
  const local = presets.find((preset) => preset.id === id);
  if (!local) {
    // Not this machine's list either — a stale chat, or another account's
    // preset. Say so rather than pushing a list that cannot contain it.
    return { ok: false, message: "This custom provider is not saved on this computer." };
  }
  const machine = await machinePreset(id);
  // Cannot answer: a row this build does not understand, or a brain that could
  // not be asked. Pushing then would replace a list this machine never read, so
  // the launch goes ahead exactly as it did before this guard existed.
  if (machine === null) return { ok: true, message: null };
  // A confirmed absence, and a copy that differs from what the user just
  // picked, both mean the brain cannot resolve this preset. Pushing on a
  // difference is deliberately not a "who is newer" comparison: this machine
  // cannot see the other side's stamp from here, and the account store's own
  // newer-wins rule is what reconciles the two lists. Launching on the model
  // the user is looking at beats holding the brain's copy untouched.
  if (machine === undefined || !samePresetOnBothSides(local, machine)) {
    return await saveHarnessPresetsToAccount();
  }
  return { ok: true, message: null };
}
