import { describe, expect, it } from "vitest";

import type { InstalledPlugin } from "../../lib/pluginRuntimeBridge";
import {
  BUILTIN_TAB_GATES,
  builtinRouteForPluginRoute,
  claimedBuiltinGate,
  isBuiltinSurfaceVisible,
  isBuiltinTabVisible,
  pluginOwnsBuiltinTab,
  supersededCompiledRouteReplacement,
  type BuiltinGateInput,
} from "./builtinTabs";
import { PLUGIN_BUILTIN_SURFACE_IDS } from "../../../shared/plugins/manifest";
import { builtinSurfacePresence } from "../../../shared/plugins/builtinSurfaces";

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

  /**
   * Both polarities, swept in one place.
   *
   * `shown` is what the surface's OWN owner does to it, and the two directions
   * are opposites: an `enables` owner reveals the compiled page, a `supersedes`
   * owner takes it away. Everything else about the sweep is the same, including
   * the rule that one plugin moves exactly one surface.
   */
  it.each(BUILTIN_TAB_GATES)("$builtinId moves only with its own owner", (gate) => {
    const supersedes = builtinSurfacePresence(gate.builtinId) === "supersedes";
    const owner = plugin({
      pluginId: gate.ownerPluginId,
      displayName: gate.title,
      tabs: supersedes
        ? [{ id: gate.builtinId, title: gate.title, panelId: "main" }]
        : [{ id: gate.builtinId, title: gate.title, panelId: "main", builtin: gate.builtinId }],
    });

    expect(isBuiltinSurfaceVisible(gate.builtinId, input())).toBe(supersedes);
    expect(isBuiltinSurfaceVisible(gate.builtinId, input({ plugins: [owner] }))).toBe(!supersedes);
    expect(isBuiltinSurfaceVisible(gate.builtinId, input({ plugins: [{ ...owner, enabled: false }] })))
      .toBe(supersedes);

    // One plugin opens one surface. Installing Review must not reveal Graph.
    for (const other of BUILTIN_TAB_GATES) {
      if (other.builtinId === gate.builtinId) continue;
      const othersDefault = builtinSurfacePresence(other.builtinId) === "supersedes";
      expect(isBuiltinSurfaceVisible(other.builtinId, input({ plugins: [owner] })), other.builtinId)
        .toBe(othersDefault);
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

  it("sends a superseded compiled route to the plugin tab once the owner is here", () => {
    const review = plugin({
      pluginId: "ade-review",
      displayName: "Review",
      tabs: [{ id: "runs", title: "Review", panelId: "runs" }],
    });
    expect(supersededCompiledRouteReplacement("/review", input())).toBeNull();
    expect(supersededCompiledRouteReplacement("/review", input({ plugins: [review] })))
      .toBe("/plugin/ade-review");
    expect(supersededCompiledRouteReplacement("/graph", input({ plugins: [plugin()] }))).toBeNull();
  });
});

/**
 * The superseded surface, whose unknowns fall the other way.
 *
 * Everything above pins "hidden until three positive facts". Cursor Cloud is
 * the mirror: ADE has shipped the compiled fleet surface all along, so the same
 * three unknowns must leave it ALONE. A regression that collapses the two
 * polarities back together shows up here as a machine that loses its Cursor
 * Cloud button for one frame on every launch, or keeps it forever after the
 * plugin arrives — one of those two, depending which way the collapse went.
 */
describe("a superseded builtin surface", () => {
  function cursorCloudPlugin(overrides: Partial<InstalledPlugin> = {}): InstalledPlugin {
    return plugin({
      pluginId: "ade-cursor-cloud",
      displayName: "Cursor Cloud",
      icon: "brand:cursor",
      accent: "#A78BFA",
      // No `builtin`: the plugin draws its own fleet tab. That is exactly the
      // shape the legacy-host fallback in `claimedBuiltinGate` used to trust.
      tabs: [{ id: "fleet", title: "Cursor Cloud", panelId: "fleet" }],
      ...overrides,
    });
  }

  it("is visible on a machine that does not have the plugin", () => {
    expect(isBuiltinSurfaceVisible("cursor-cloud", input({ plugins: [] }))).toBe(true);
  });

  it("is visible while the registry is still loading, unlike an enabling surface", () => {
    const loading = input({ pluginsLoaded: false, plugins: [cursorCloudPlugin()] });
    expect(isBuiltinSurfaceVisible("cursor-cloud", loading)).toBe(true);
    expect(isBuiltinSurfaceVisible("graph", input({ pluginsLoaded: false, plugins: [plugin()] }))).toBe(false);
  });

  it("is visible on a host with no plugin support at all", () => {
    expect(isBuiltinSurfaceVisible("cursor-cloud", input({ pluginSupport: false }))).toBe(true);
  });

  it("is visible when the plugin is installed but switched off", () => {
    expect(isBuiltinSurfaceVisible("cursor-cloud", input({ plugins: [cursorCloudPlugin({ enabled: false })] })))
      .toBe(true);
  });

  it("is hidden exactly once the plugin is installed and enabled", () => {
    expect(isBuiltinSurfaceVisible("cursor-cloud", input({ plugins: [cursorCloudPlugin()] }))).toBe(false);
  });

  it("keeps the plugin's own rail item, because ADE draws nothing in its place", () => {
    // The bug this pins: `builtinGateForPlugin` finds the registered owner, and
    // the legacy-host fallback then treats a plugin with no `builtin` tab as
    // claiming the surface. For a superseding plugin that would suppress its own
    // tab and leave the rail with neither entry.
    const installed = cursorCloudPlugin();
    expect(claimedBuiltinGate(installed)).toBeNull();
    expect(pluginOwnsBuiltinTab(installed)).toBe(false);
    expect(builtinRouteForPluginRoute("ade-cursor-cloud", [installed])).toBeNull();
  });

  it("leaves every enabling surface on the original polarity", () => {
    const withCursorCloud = input({ plugins: [cursorCloudPlugin()] });
    for (const builtinId of PLUGIN_BUILTIN_SURFACE_IDS) {
      if (builtinSurfacePresence(builtinId) === "supersedes") continue;
      expect(isBuiltinSurfaceVisible(builtinId, withCursorCloud), builtinId).toBe(false);
    }
  });
});

/**
 * Linear, the surface that changed polarity — and the one the user's acceptance
 * test runs through.
 *
 * "An ADE install with no Linear, install `ade-linear`, it works fully" only
 * holds if the compiled Linear pane is present on every machine that does not
 * have the plugin, and absent on every machine that does. The first half is the
 * half a gate gets wrong: an unresolved registry must not delete an integration
 * ADE has shipped for years, so every unknown draws.
 */
describe("isBuiltinSurfaceVisible for the superseded Linear surface", () => {
  function linearPlugin(overrides: Partial<InstalledPlugin> = {}): InstalledPlugin {
    return plugin({
      pluginId: "ade-linear",
      displayName: "Linear",
      icon: "list-checks",
      accent: "#5E6AD2",
      // No `builtin`: the plugin draws its own issues tab. The manifest parser
      // refuses the field on a superseded surface, so this is the only shape a
      // real `ade-linear` install can have.
      tabs: [{ id: "issues", title: "Linear", panelId: "issues" }],
      ...overrides,
    });
  }

  it("is visible on a machine that does not have the plugin", () => {
    expect(isBuiltinSurfaceVisible("linear", input({ plugins: [] }))).toBe(true);
  });

  it("is visible while the registry is still loading", () => {
    expect(isBuiltinSurfaceVisible("linear", input({ pluginsLoaded: false, plugins: [linearPlugin()] })))
      .toBe(true);
  });

  it("is visible on a host with no plugin support at all", () => {
    expect(isBuiltinSurfaceVisible("linear", input({ pluginSupport: false }))).toBe(true);
  });

  it("is visible when the plugin is installed but switched off", () => {
    expect(isBuiltinSurfaceVisible("linear", input({ plugins: [linearPlugin({ enabled: false })] })))
      .toBe(true);
  });

  it("is hidden exactly once the plugin is installed and enabled", () => {
    expect(isBuiltinSurfaceVisible("linear", input({ plugins: [linearPlugin()] }))).toBe(false);
  });

  it("keeps the plugin's own rail item, because ADE draws nothing in its place", () => {
    const installed = linearPlugin();
    expect(claimedBuiltinGate(installed)).toBeNull();
    expect(pluginOwnsBuiltinTab(installed)).toBe(false);
    expect(builtinRouteForPluginRoute("ade-linear", [installed])).toBeNull();
  });

  it("is unmoved by any plugin that is not the registered owner", () => {
    const impostor = plugin({ pluginId: "someone-elses-linear", tabs: [{ id: "issues", title: "Linear", panelId: "issues" }] });
    expect(isBuiltinSurfaceVisible("linear", input({ plugins: [impostor] }))).toBe(true);
  });
});
