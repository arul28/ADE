import { afterEach, describe, expect, it } from "vitest";

import {
  availableSettingsEntries,
  clearBuiltinSurfaceResolver,
  isBuiltinSurfaceShown,
  searchSettingsEntries,
  setBuiltinSurfaceResolver,
  settingsEntriesForTab,
} from "./settingsManifest";
import type { PluginBuiltinSurfaceId } from "../../../shared/plugins/manifest";

/**
 * The `integrations.linear` row against the surface its card belongs to.
 *
 * `LinearIntegrationSection` returns null once `ade-linear` is installed, so
 * `#linear-connection` has nothing to scroll to. The manifest feeds three
 * surfaces from one list — the settings nav, the settings page's own search, and
 * the Cmd-K palette — so the row has to leave all three together, which is why
 * this is asserted on the manifest rather than on any one of them.
 *
 * No render: the manifest is a plain module and the resolver is the seam the
 * React surfaces install. Driving the seam directly is what lets the three
 * registry states be told apart without a store.
 */

const LINEAR_ID = "integrations.linear";
const GITHUB_ID = "integrations.github";

function ids(entries: { id: string }[]): string[] {
  return entries.map((entry) => entry.id);
}

afterEach(() => {
  setBuiltinSurfaceResolver(null);
});

describe("the Linear settings row and the Linear surface", () => {
  it("keeps the row when no resolver is installed, which is every host without plugins", () => {
    // The default a surface falls back to is the polarity's own: Linear is
    // superseded, so ADE draws it until a plugin positively takes it over.
    expect(isBuiltinSurfaceShown("linear")).toBe(true);
    expect(ids(availableSettingsEntries())).toContain(LINEAR_ID);
    expect(ids(settingsEntriesForTab("integrations"))).toEqual([GITHUB_ID, LINEAR_ID]);
    expect(ids(searchSettingsEntries("linear"))).toContain(LINEAR_ID);
  });

  it("keeps the row while the registry has not resolved", () => {
    // An unresolved registry answers the same way an absent one does for a
    // superseded surface, so the row must not flicker out on startup.
    setBuiltinSurfaceResolver(() => true);
    expect(ids(availableSettingsEntries())).toContain(LINEAR_ID);
    expect(ids(searchSettingsEntries("oauth"))).toContain(LINEAR_ID);
  });

  it("drops the row from nav, search and the palette list once the plugin owns Linear", () => {
    setBuiltinSurfaceResolver((builtinId) => builtinId !== "linear");
    expect(ids(availableSettingsEntries())).not.toContain(LINEAR_ID);
    expect(ids(searchSettingsEntries("linear"))).not.toContain(LINEAR_ID);
    expect(ids(searchSettingsEntries("ticket"))).not.toContain(LINEAR_ID);
    expect(ids(settingsEntriesForTab("integrations"))).toEqual([GITHUB_ID]);
  });

  it("takes nothing else with it", () => {
    const withLinear = ids(availableSettingsEntries());
    setBuiltinSurfaceResolver((builtinId) => builtinId !== "linear");
    expect(ids(availableSettingsEntries()))
      .toEqual(withLinear.filter((id) => id !== LINEAR_ID));
  });

  it("only takes down its own resolver, because two surfaces install one", () => {
    // The settings page and the palette both install a resolver and unmount in
    // no fixed order. An unconditional clear on unmount would leave the manifest
    // answering for a surface the other one is still watching.
    const pageResolver = (builtinId: PluginBuiltinSurfaceId) => builtinId !== "linear";
    const paletteResolver = (builtinId: PluginBuiltinSurfaceId) => builtinId !== "linear";
    setBuiltinSurfaceResolver(pageResolver);
    setBuiltinSurfaceResolver(paletteResolver);
    clearBuiltinSurfaceResolver(pageResolver);
    expect(ids(availableSettingsEntries())).not.toContain(LINEAR_ID);
    clearBuiltinSurfaceResolver(paletteResolver);
    expect(ids(availableSettingsEntries())).toContain(LINEAR_ID);
  });
});
