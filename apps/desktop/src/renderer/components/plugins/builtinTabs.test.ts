import { describe, expect, it } from "vitest";

import type { InstalledPlugin } from "../../lib/pluginRuntimeBridge";
import {
  BUILTIN_TAB_GATES,
  builtinRouteForPluginRoute,
  claimedBuiltinGate,
  isBuiltinSurfaceVisible,
  isBuiltinTabVisible,
  pluginOwnsBuiltinTab,
  type BuiltinGateInput,
} from "./builtinTabs";
import { PLUGIN_BUILTIN_SURFACE_IDS } from "../../../shared/plugins/manifest";

/**
 * The rules for a compiled surface a plugin owns.
 *
 * The asymmetry is the whole point and is asserted from both sides: showing a
 * surface takes three positive facts, and hiding it takes any single one of
 * them being missing. These tests were written the other way round in round 1,
 * when the surfaces were seeded onto every machine and hiding one had to be
 * earned. Nothing is seeded now, so a machine with no plugins correctly has no
 * Graph tab — and a regression that reintroduces "show it when unsure" puts
 * every extracted surface back on every install.
 */

function plugin(overrides: Partial<InstalledPlugin> = {}): InstalledPlugin {
  return {
    pluginId: "ade-graph",
    displayName: "Graph",
    version: "1.0.0",
    enabled: true,
    icon: "graph",
    accent: "#7C6FF0",
    status: "none",
    tabs: [{ id: "graph", title: "Graph", panelId: "main", builtin: "graph" }],
    theme: null,
    ...overrides,
  };
}

function input(overrides: Partial<BuiltinGateInput> = {}): BuiltinGateInput {
  return {
    pluginSupport: true,
    pluginsLoaded: true,
    plugins: [],
    ...overrides,
  };
}

describe("isBuiltinTabVisible", () => {
  it("shows a route no plugin gates", () => {
    expect(isBuiltinTabVisible("/lanes", input())).toBe(true);
  });

  it("shows the tab when the owner is installed and enabled", () => {
    expect(isBuiltinTabVisible("/graph", input({ plugins: [plugin()] }))).toBe(true);
  });

  it("hides the tab when the owner is disabled", () => {
    expect(isBuiltinTabVisible("/graph", input({ plugins: [plugin({ enabled: false })] }))).toBe(false);
  });

  it("hides the tab when the owner is not installed", () => {
    expect(isBuiltinTabVisible("/graph", input({ plugins: [] }))).toBe(false);
  });

  it("hides the tab while the registry is still loading", () => {
    // "Not loaded yet" and "not installed" answer the same on purpose. A tab
    // that appeared for one frame and then vanished would read as a glitch, and
    // the honest default before the facts arrive is the shipped one: hidden.
    expect(isBuiltinTabVisible("/graph", input({ pluginsLoaded: false, plugins: [plugin()] }))).toBe(false);
  });

  it("hides the tab on a host with no plugin support at all", () => {
    expect(isBuiltinTabVisible("/graph", input({ pluginSupport: false, plugins: [plugin()] }))).toBe(false);
  });

  it("ignores an unrelated installed plugin", () => {
    const other = plugin({ pluginId: "ade-log-viewer", displayName: "Log viewer", tabs: [] });
    expect(isBuiltinTabVisible("/graph", input({ plugins: [other] }))).toBe(false);
  });
});

describe("every registered surface", () => {
  it("has a gate for each id in the shared manifest list", () => {
    expect(BUILTIN_TAB_GATES.map((gate) => gate.builtinId).sort())
      .toEqual([...PLUGIN_BUILTIN_SURFACE_IDS].sort());
  });

  it.each(BUILTIN_TAB_GATES)("$builtinId is hidden by default and shown by its own owner", (gate) => {
    const owner = plugin({
      pluginId: gate.ownerPluginId,
      displayName: gate.title,
      tabs: [{ id: gate.builtinId, title: gate.title, panelId: "main", builtin: gate.builtinId }],
    });

    expect(isBuiltinSurfaceVisible(gate.builtinId, input())).toBe(false);
    expect(isBuiltinSurfaceVisible(gate.builtinId, input({ plugins: [owner] }))).toBe(true);
    expect(isBuiltinSurfaceVisible(gate.builtinId, input({ plugins: [{ ...owner, enabled: false }] }))).toBe(false);

    // One plugin opens one surface. Installing Review must not reveal Graph.
    for (const other of BUILTIN_TAB_GATES) {
      if (other.builtinId === gate.builtinId) continue;
      expect(isBuiltinSurfaceVisible(other.builtinId, input({ plugins: [owner] })), other.builtinId).toBe(false);
    }
  });
});

describe("gate ownership", () => {
  it("recognises the registered owner", () => {
    expect(pluginOwnsBuiltinTab(plugin())).toBe(true);
    expect(claimedBuiltinGate(plugin())?.route).toBe("/graph");
  });

  it("does not let an unregistered plugin claim a compiled surface", () => {
    const impostor = plugin({ pluginId: "graph-pro", displayName: "Graph Pro" });
    expect(pluginOwnsBuiltinTab(impostor)).toBe(false);
    expect(isBuiltinTabVisible("/graph", input({ plugins: [impostor] }))).toBe(false);
  });

  it("trusts the registered owner on a host that reports no builtin field", () => {
    // Older host, or one whose summary drops the field: the owner is still the
    // owner, and the alternative is a duplicate rail item exactly there.
    const older = plugin({ tabs: [{ id: "graph", title: "Graph", panelId: "main" }] });
    expect(pluginOwnsBuiltinTab(older)).toBe(true);
  });

  it("does not treat an owner's ordinary second tab as a gate", () => {
    const withOtherTab = plugin({
      tabs: [
        { id: "graph", title: "Graph", panelId: "main", builtin: "graph" },
        { id: "extra", title: "Extra", panelId: "extra", builtin: null },
      ],
    });
    expect(claimedBuiltinGate(withOtherTab)?.builtinId).toBe("graph");
  });

  it("routes the plugin page to the compiled tab it owns", () => {
    expect(builtinRouteForPluginRoute("ade-graph", [plugin()])).toBe("/graph");
    expect(builtinRouteForPluginRoute("ade-log-viewer", [plugin()])).toBeNull();
    expect(builtinRouteForPluginRoute("ade-graph", [])).toBeNull();
  });

  it("does not route a pane owner anywhere, because its surface has no route", () => {
    // Linear lives inside Work. `/plugin/ade-linear` has nowhere to redirect to,
    // so it must fall through and draw the plugin's own fallback card instead of
    // sending someone to a route that does not exist.
    const linear = plugin({
      pluginId: "ade-linear",
      displayName: "Linear",
      tabs: [{ id: "linear", title: "Linear", panelId: "main", builtin: "linear" }],
    });
    expect(builtinRouteForPluginRoute("ade-linear", [linear])).toBeNull();
  });

  it("does not route to a surface whose owner is installed but disabled", () => {
    expect(builtinRouteForPluginRoute("ade-graph", [plugin({ enabled: false })])).toBeNull();
  });
});
