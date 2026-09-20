/**
 * Reading and writing the preset list.
 *
 * One hook so every surface — the settings table, the wizard, the model picker
 * — goes through the same four operations and the same id minting. The list is
 * a single account-scoped preference (`ade.userPreferences.v1` →
 * `harnessPresets`, registered in `accountSettingsSync.ts`), so a save here
 * lands on localStorage immediately and reaches the account on the next sync
 * tick; there is no separate store to keep in step.
 */

import { useCallback } from "react";
import { useRootAppStore } from "../../../state/appStore";
import {
  normalizeHarnessPreset,
  uniqueHarnessPresetName,
  type HarnessPreset,
  type HarnessPresetDraft,
} from "../../../../shared/harnessPresets";

/** Ids are opaque and local: nothing outside this list resolves them. */
function mintPresetId(): string {
  const random =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : Math.random().toString(36).slice(2);
  return `hp_${random}`;
}

export type HarnessPresetsApi = {
  presets: HarnessPreset[];
  /** Create from a draft. Returns the saved preset, id and timestamps included. */
  createPreset: (draft: HarnessPresetDraft) => HarnessPreset | null;
  /** Replace one preset's settings, stamping `updatedAt`. */
  updatePreset: (id: string, draft: HarnessPresetDraft) => HarnessPreset | null;
  /** Copy a preset under a free name, placed right after the original. */
  duplicatePreset: (id: string) => HarnessPreset | null;
  deletePreset: (id: string) => void;
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

  const createPreset = useCallback(
    (draft: HarnessPresetDraft): HarnessPreset | null => {
      const now = new Date().toISOString();
      const candidate = normalizeHarnessPreset({ ...draft, id: mintPresetId(), createdAt: now, updatedAt: now });
      if (!candidate) return null;
      setHarnessPresets((prev) => [
        ...prev,
        { ...candidate, name: uniqueHarnessPresetName(candidate.name, prev.map((entry) => entry.name)) },
      ]);
      return candidate;
    },
    [setHarnessPresets],
  );

  const updatePreset = useCallback(
    (id: string, draft: HarnessPresetDraft): HarnessPreset | null => {
      const existing = presets.find((entry) => entry.id === id);
      if (!existing) return null;
      const candidate = normalizeHarnessPreset({
        ...draft,
        id,
        createdAt: existing.createdAt,
        updatedAt: new Date().toISOString(),
      });
      if (!candidate) return null;
      setHarnessPresets((prev) => prev.map((entry) => (entry.id === id ? candidate : entry)));
      return candidate;
    },
    [presets, setHarnessPresets],
  );

  const duplicatePreset = useCallback(
    (id: string): HarnessPreset | null => {
      const existing = presets.find((entry) => entry.id === id);
      if (!existing) return null;
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
      return copy;
    },
    [presets, setHarnessPresets],
  );

  const deletePreset = useCallback(
    (id: string) => {
      setHarnessPresets((prev) => prev.filter((entry) => entry.id !== id));
    },
    [setHarnessPresets],
  );

  const presetById = useCallback(
    (id: string) => presets.find((entry) => entry.id === id) ?? null,
    [presets],
  );

  return { presets, createPreset, updatePreset, duplicatePreset, deletePreset, presetById };
}
