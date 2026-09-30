/**
 * Reading and writing the preset list.
 *
 * One hook so every surface — the settings table, the wizard, the model picker
 * — goes through the same four operations and the same id minting. The list is
 * a single account-scoped preference (`ade.userPreferences.v1` →
 * `harnessPresets`, registered in `accountSettingsSync.ts`), so a save here
 * lands on localStorage immediately and reaches the account on the next sync
 * tick; there is no separate store to keep in step.
 *
 * WHAT EACH MUTATION AWAITS: not the account's eventual convergence, but the
 * brain's own answer about THIS write. The brain is what resolves a launch, and
 * it reads the same `account-settings.json` this writes, so "saved" used to
 * mean "saved here, maybe there" — a save followed straight away by a launch
 * could miss by seconds and report the preset as gone. Each mutation now
 * resolves once the brain has confirmed it, and says so when it has not:
 * `accountError` is a sentence for the user, never a thrown save. The preset is
 * kept either way — the local copy is the user's work — and stays queued for
 * the ordinary retry.
 */

import { useCallback } from "react";
import { useRootAppStore } from "../../../state/appStore";
import {
  normalizeHarnessPreset,
  uniqueHarnessPresetName,
  type HarnessPreset,
  type HarnessPresetDraft,
} from "../../../../shared/harnessPresets";
import { saveHarnessPresetsToAccount } from "../../../lib/harnessPresetAccountSync";

/** Ids are opaque and local: nothing outside this list resolves them. */
function mintPresetId(): string {
  const random =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : Math.random().toString(36).slice(2);
  return `hp_${random}`;
}

/**
 * What one write did.
 *
 * `preset` is what the local list holds now (null when nothing was written).
 * `accountError` is set when the account has not confirmed it yet — the write
 * is queued and retried, but the user has to know before they launch on it.
 */
export type HarnessPresetWriteResult = {
  preset: HarnessPreset | null;
  accountError: string | null;
};

export type HarnessPresetsApi = {
  presets: HarnessPreset[];
  /** Create from a draft, once the account has confirmed it. */
  createPreset: (draft: HarnessPresetDraft) => Promise<HarnessPresetWriteResult>;
  /** Replace one preset's settings, stamping `updatedAt`, once confirmed. */
  updatePreset: (id: string, draft: HarnessPresetDraft) => Promise<HarnessPresetWriteResult>;
  /** Copy a preset under a free name, placed right after the original. */
  duplicatePreset: (id: string) => Promise<HarnessPresetWriteResult>;
  /** Remove one. Resolves once the account has confirmed the removal. */
  deletePreset: (id: string) => Promise<{ accountError: string | null }>;
  presetById: (id: string) => HarnessPreset | null;
};

export function useHarnessPresets(): HarnessPresetsApi {
  // WHY the ROOT store: a project tab runs its own store, seeded from the root
  // once at creation, and `setHarnessPresets` on that copy is the ROOT setter.
  // Reading the project copy would therefore show a list that a create or a
  // delete never reaches — the row lands in localStorage and the account, and
  // the table silently stays one edit behind. The list is an account-scoped
  // preference, so the root store is its only owner (same rule the composer
  // already follows for `promptStashButtonEnabled`).
  const presets = useRootAppStore((state) => state.harnessPresets);
  const setHarnessPresets = useRootAppStore((state) => state.setHarnessPresets);

  /** One confirmed push after a local write, as a result the caller can show. */
  const confirmAccountWrite = useCallback(async (): Promise<string | null> => {
    const outcome = await saveHarnessPresetsToAccount();
    return outcome.ok ? null : outcome.message;
  }, []);

  const createPreset = useCallback(
    async (draft: HarnessPresetDraft): Promise<HarnessPresetWriteResult> => {
      const now = new Date().toISOString();
      const candidate = normalizeHarnessPreset({ ...draft, id: mintPresetId(), createdAt: now, updatedAt: now });
      if (!candidate) return { preset: null, accountError: null };
      // Named against the list as it is now, and returned under that name: the
      // caller announces what it was handed, and a colliding name is renamed on
      // the way in — so returning the un-renamed candidate announced a preset
      // the list does not have.
      const stored: HarnessPreset = {
        ...candidate,
        name: uniqueHarnessPresetName(candidate.name, presets.map((entry) => entry.name)),
      };
      setHarnessPresets((prev) => [...prev, stored]);
      return { preset: stored, accountError: await confirmAccountWrite() };
    },
    [confirmAccountWrite, presets, setHarnessPresets],
  );

  const updatePreset = useCallback(
    async (id: string, draft: HarnessPresetDraft): Promise<HarnessPresetWriteResult> => {
      const existing = presets.find((entry) => entry.id === id);
      if (!existing) return { preset: null, accountError: null };
      const candidate = normalizeHarnessPreset({
        ...draft,
        id,
        createdAt: existing.createdAt,
        updatedAt: new Date().toISOString(),
      });
      if (!candidate) return { preset: null, accountError: null };
      setHarnessPresets((prev) => prev.map((entry) => (entry.id === id ? candidate : entry)));
      return { preset: candidate, accountError: await confirmAccountWrite() };
    },
    [confirmAccountWrite, presets, setHarnessPresets],
  );

  const duplicatePreset = useCallback(
    async (id: string): Promise<HarnessPresetWriteResult> => {
      const existing = presets.find((entry) => entry.id === id);
      if (!existing) return { preset: null, accountError: null };
      const now = new Date().toISOString();
      const copy: HarnessPreset = {
        ...existing,
        id: mintPresetId(),
        name: uniqueHarnessPresetName(existing.name, presets.map((entry) => entry.name)),
        createdAt: now,
        updatedAt: now,
      };
      setHarnessPresets((prev) => {
        const index = prev.findIndex((entry) => entry.id === id);
        if (index < 0) return [...prev, copy];
        return [...prev.slice(0, index + 1), copy, ...prev.slice(index + 1)];
      });
      return { preset: copy, accountError: await confirmAccountWrite() };
    },
    [confirmAccountWrite, presets, setHarnessPresets],
  );

  const deletePreset = useCallback(
    async (id: string): Promise<{ accountError: string | null }> => {
      setHarnessPresets((prev) => prev.filter((entry) => entry.id !== id));
      return { accountError: await confirmAccountWrite() };
    },
    [confirmAccountWrite, setHarnessPresets],
  );

  const presetById = useCallback(
    (id: string) => presets.find((entry) => entry.id === id) ?? null,
    [presets],
  );

  return { presets, createPreset, updatePreset, duplicatePreset, deletePreset, presetById };
}
