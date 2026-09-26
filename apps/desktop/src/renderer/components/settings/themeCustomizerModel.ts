/**
 * The customizer's save rule, kept apart from the dialog so it can be tested
 * without rendering React.
 *
 * The one contract that matters: **editing a shipped theme never mutates it.**
 * Save always writes into the custom list, and a theme derived from a shipped
 * base gets a brand-new, collision-free id. Editing an existing custom theme
 * keeps its id so the gallery updates the theme in place instead of growing a
 * duplicate on every save.
 */

import {
  normalizeAdeTheme,
  uniqueThemeId,
  type AdeTheme,
} from "../../../shared/theme";

export type PlanThemeSaveArgs = {
  /** The editor's draft, with whatever palette the user built. */
  draft: AdeTheme;
  /** The name field's raw value. */
  name: string;
  /** True when the active theme is already a custom theme. */
  editingExisting: boolean;
  /** Every id already in use (shipped + custom). */
  takenIds: readonly string[];
  /** The theme the draft started from. */
  baseId: string;
};

/** Produce the theme to store, or null when the draft cannot be saved. */
export function planThemeSave(args: PlanThemeSaveArgs): AdeTheme | null {
  const name = args.name.trim();
  if (!name) return null;
  const id = args.editingExisting ? args.draft.id : uniqueThemeId(name, args.takenIds);
  const draft: AdeTheme = { ...args.draft };
  // A draft based on a shipped theme starts as a clone of it, so it carries the
  // shipped theme's description and author; neither describes the user's theme.
  // An existing custom theme (which may carry its own, e.g. from an import)
  // keeps what it has.
  if (!args.editingExisting) {
    delete draft.description;
    delete draft.author;
  }
  return normalizeAdeTheme(
    {
      ...draft,
      id,
      name,
      source: "custom",
      basedOn: args.draft.basedOn ?? args.baseId,
    },
    { source: "custom", id },
  );
}

/** Add or replace `theme` in `list`, preserving order for a replacement. */
export function upsertCustomTheme(list: readonly AdeTheme[], theme: AdeTheme): AdeTheme[] {
  const index = list.findIndex((entry) => entry.id === theme.id);
  if (index === -1) return [...list, theme];
  const next = list.slice();
  next[index] = theme;
  return next;
}
