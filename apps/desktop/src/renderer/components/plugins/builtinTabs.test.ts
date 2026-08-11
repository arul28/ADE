import { describe, expect, it } from "vitest";

import type { InstalledPlugin } from "../../lib/pluginRuntimeBridge";
import {
  builtinRouteForPluginRoute,
  claimedBuiltinGate,
  isBuiltinTabVisible,
  pluginOwnsBuiltinTab,
  type BuiltinGateInput,
} from "./builtinTabs";

/**
 * The rail's rules for a plugin-gated built-in tab.
 *
 * The asymmetry is the whole point and is asserted from both sides: hiding a tab
 * takes four positive facts, while showing one takes any single uncertainty. A
 * regression that makes hiding easier deletes a tab from working installs on
 * upgrade day, and no user reports that as a plugin bug.
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
    seen: new Set(["graph"]),
    ...overrides,
  };
}

describe("isBuiltinTabVisible", () => {
  it("shows a route no plugin gates", () => {
    expect(isBuiltinTabVisible("/lanes", input({ seen: new Set() }))).toBe(true);
  });

  it("shows the tab when the owner is installed and enabled", () => {
    expect(isBuiltinTabVisible("/graph", input({ plugins: [plugin()] }))).toBe(true);
  });

  it("hides the tab when the owner is disabled", () => {
    expect(isBuiltinTabVisible("/graph", input({ plugins: [plugin({ enabled: false })] }))).toBe(false);
  });

  it("hides the tab once the owner has been seen and is now gone", () => {
    expect(isBuiltinTabVisible("/graph", input({ plugins: [] }))).toBe(false);
  });

  it("shows the tab on a machine that has never had the owner", () => {
    // The upgrade case: plugins exist, the registry is loaded, and this machine
    // has simply always had a Graph tab. Absence is not removal.
    expect(isBuiltinTabVisible("/graph", input({ plugins: [], seen: new Set() }))).toBe(true);
  });

  it("shows the tab while the registry is still loading", () => {
    expect(isBuiltinTabVisible("/graph", input({ pluginsLoaded: false }))).toBe(true);
  });

  it("shows the tab on a host with no plugin support at all", () => {
    expect(isBuiltinTabVisible("/graph", input({ pluginSupport: false }))).toBe(true);
  });

  it("ignores an unrelated installed plugin", () => {
    const other = plugin({ pluginId: "ade-log-viewer", displayName: "Log viewer", tabs: [] });
    expect(isBuiltinTabVisible("/graph", input({ plugins: [other] }))).toBe(false);
  });
});

describe("gate ownership", () => {
  it("recognises the registered owner", () => {
    expect(pluginOwnsBuiltinTab(plugin())).toBe(true);
    expect(claimedBuiltinGate(plugin())?.route).toBe("/graph");
  });

  it("does not let an unregistered plugin claim a built-in tab", () => {
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

  it("routes the plugin page to the built-in tab it owns", () => {
    expect(builtinRouteForPluginRoute("ade-graph", [plugin()])).toBe("/graph");
    expect(builtinRouteForPluginRoute("ade-log-viewer", [plugin()])).toBeNull();
    expect(builtinRouteForPluginRoute("ade-graph", [])).toBeNull();
  });
});
