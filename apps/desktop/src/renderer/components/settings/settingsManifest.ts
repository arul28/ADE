/**
 * What the settings registry can reach in THIS renderer.
 *
 * The registry itself (tabs, entries, aliases, routes) lives in
 * `shared/settingsManifest.ts` so the CLI and the brain read the same data;
 * this file re-exports it and adds the parts that depend on where the
 * renderer runs: the platform, the hosted web client, and standalone Settings.
 * Every existing `from "./settingsManifest"` import keeps working.
 */

import {
  SETTINGS_ENTRIES,
  SETTINGS_TABS,
  scoreSettingsEntry,
  settingsEntryById,
  type SettingEntry,
  type SettingWebScope,
  type SettingsTab,
  type SettingsTabId,
} from "../../../shared/settingsManifest";
import { isMacPlatform } from "../../lib/platform";
import { isWebClientMode } from "../../lib/webClientMode";

export * from "../../../shared/settingsManifest";

/**
 * Whether a setting is reachable from the renderer we are running in. Every
 * setting but a web-only one is reachable on the desktop; the web client drops
 * the ones whose writes have nowhere to land. Nav, search, and the palette all read this, so
 * a hidden setting is hidden everywhere at once rather than only in the nav.
 *
 * `resolveSettingsTab` and `resolveSettingsHash` deliberately do not: a URL
 * that names a hidden setting still resolves, and the settings shell decides
 * where to land it.
 */
export function isSettingAvailable(entry: SettingEntry): boolean {
  if (entry.macOnly && !isMacPlatform()) return false;
  if (!isWebClientMode()) {
    // Standalone Settings, opened from the new-project screen with no project:
    // a project-scoped setting has nowhere to write, so it is hidden here as
    // it is on the web client with no bound machine.
    if (standaloneSettingsResolver?.() ?? false) {
      return entry.webOnly !== true && entry.scope !== "account-repo" && entry.scope !== "machine-repo";
    }
    return entry.webOnly !== true;
  }
  if (entry.web === "hidden") return false;
  // A machine-scoped setting writes to the machine the active project tab is
  // bound to. With no tab open there is no such machine, so the control would
  // be a write with nowhere to land — the same reason `hidden` exists.
  return entry.web !== "machine" || hasWebMachineBinding();
}

/**
 * Whether Settings is open with no project — the new-project screen's own
 * Settings entry. Installing the resolver hides every project-scoped setting
 * from nav, search and the palette at once.
 */
let standaloneSettingsResolver: (() => boolean) | null = null;

export function setStandaloneSettingsResolver(resolve: () => boolean): void {
  standaloneSettingsResolver = resolve;
}

/**
 * Whether Settings is open with no project. A page that mixes this computer's
 * settings with ones saved in a project reads this to leave the project cards
 * out: with no project there is nothing to load them from or save them to.
 */
export function isStandaloneSettings(): boolean {
  return standaloneSettingsResolver?.() ?? false;
}

/** Uninstall a standalone resolver, but only if it is still the installed one. */
export function clearStandaloneSettingsResolver(resolve: () => boolean): void {
  if (standaloneSettingsResolver === resolve) standaloneSettingsResolver = null;
}

/**
 * The scope of a section, read off the settings it contains. A section is
 * `hidden` on web only when every setting in it is — this module is the one
 * place that decides, so nav, search, and the scope banner cannot disagree.
 *
 * Unreachable is broader than `hidden`: a machine-scoped setting is also
 * unreachable while no project tab is bound, because there is no machine for
 * its write to land on. `isSettingAvailable` owns that judgement.
 *
 * `entryIds` are manifest ids; an id that resolves to nothing contributes
 * nothing, and `null` means "nothing here to describe".
 */
export function sectionWebScope(entryIds: readonly string[]): SettingWebScope | null {
  const scopes = entryIds
    .map((id) => settingsEntryById(id))
    .filter((entry): entry is SettingEntry => entry != null)
    .map((entry): SettingWebScope => (isSettingAvailable(entry) ? entry.web : "hidden"));
  if (scopes.length === 0) return null;

  // Notifications is the mixed case: account-synced delivery rules alongside
  // one browser-local sound. The banner
  // describes where most of the section goes, not the loudest exception —
  // ties break toward the narrowest claim, which is why the ranking is ordered.
  const tally = new Map<SettingWebScope, number>();
  for (const scope of scopes) tally.set(scope, (tally.get(scope) ?? 0) + 1);
  if (tally.get("hidden") === scopes.length) return "hidden";

  // `machine` doubles as the initial value, so the ranking needs no non-null
  // assertion to read its own first element.
  let best: Exclude<SettingWebScope, "hidden"> = "machine";
  const NARROWEST_FIRST: Exclude<SettingWebScope, "hidden">[] = ["account", "browser"];
  for (const scope of NARROWEST_FIRST) {
    if ((tally.get(scope) ?? 0) > (tally.get(best) ?? 0)) best = scope;
  }
  return best;
}

/**
 * Whether the hosted client currently has a machine to write machine-scoped
 * settings to — i.e. whether a project tab is bound.
 *
 * A resolver rather than a flag: nav, search and the palette all ask
 * `isSettingAvailable` mid-render, so the answer has to be read at call time
 * from live app state instead of pushed here on a lifecycle event that may not
 * have run yet. The desktop never installs one, and never asks.
 */
let webMachineBindingResolver: (() => boolean) | null = null;

export function setWebMachineBindingResolver(resolve: (() => boolean) | null): void {
  webMachineBindingResolver = resolve;
}

/**
 * Uninstall a resolver, but only if it is still the installed one.
 *
 * Two surfaces install a resolver (the settings page and the palette) and they
 * unmount in no fixed order, so an unconditional clear on unmount would tear
 * down a resolver the OTHER surface had since installed, leaving the manifest
 * answering `false` for a machine that is in fact bound.
 */
export function clearWebMachineBindingResolver(resolve: () => boolean): void {
  if (webMachineBindingResolver === resolve) webMachineBindingResolver = null;
}

export function hasWebMachineBinding(): boolean {
  return webMachineBindingResolver?.() ?? false;
}

/** Whether any of these settings is reachable right now. */
export function sectionHasAvailableEntries(entryIds: readonly string[]): boolean {
  return entryIds.some((id) => {
    const entry = settingsEntryById(id);
    return entry != null && isSettingAvailable(entry);
  });
}

/** Every setting reachable in this renderer, in manifest order. */
export function availableSettingsEntries(): SettingEntry[] {
  return SETTINGS_ENTRIES.filter(isSettingAvailable);
}

/** Tabs with at least one reachable setting, in manifest order. */
export function availableSettingsTabs(): SettingsTab[] {
  return SETTINGS_TABS.filter((tab) => settingsEntriesForTab(tab.id).length > 0);
}

export function settingsEntriesForTab(tab: SettingsTabId): SettingEntry[] {
  return SETTINGS_ENTRIES.filter((entry) => entry.tab === tab && isSettingAvailable(entry));
}

/** Group names for a tab, in first-appearance order. */
export function settingsGroupsForTab(tab: SettingsTabId): string[] {
  const seen: string[] = [];
  for (const entry of settingsEntriesForTab(tab)) {
    if (!seen.includes(entry.group)) seen.push(entry.group);
  }
  return seen;
}

/** Matching reachable entries across every tab, best match first. */
export function searchSettingsEntries(query: string): SettingEntry[] {
  const q = query.trim();
  if (!q) return [];
  return availableSettingsEntries()
    .map((entry) => ({ entry, score: scoreSettingsEntry(entry, q) }))
    .filter((row): row is { entry: SettingEntry; score: number } => row.score !== null)
    .sort((left, right) => left.score - right.score)
    .map((row) => row.entry);
}

/**
 * Why a setting is out of reach in this renderer, in one line for a person, or
 * null when it is reachable. A settings chip in a chat shows this instead of a
 * click that lands on a page without the card.
 */
export function settingUnavailableReason(entry: SettingEntry): string | null {
  if (isSettingAvailable(entry)) return null;
  if (entry.macOnly && !isMacPlatform()) return "This setting is only on macOS.";
  if (entry.webOnly) return "This setting is only in the ADE web app.";
  if (isWebClientMode()) {
    if (entry.web === "hidden") return "Open ADE on your computer to change this.";
    return "Connect to a project to change this.";
  }
  return "Open a project to change this.";
}
