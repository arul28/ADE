import { describe, expect, it } from "vitest";

import {
  BUILTIN_SURFACE_OWNERS,
  builtinSurfaceInstalled,
  builtinSurfaceOwner,
  builtinSurfaceOwnerForPlugin,
  builtinSurfaceOwnerForRoute,
} from "./builtinSurfaces";
import { PLUGIN_BUILTIN_SURFACE_IDS } from "./manifest";

/**
 * The half of the gate both processes share.
 *
 * The renderer adds "has the registry loaded" and "does this host publish
 * plugins" on top; main adds "what does state.json say". Neither may add a way
 * for the answer to differ for the same registry contents, which is what these
 * assertions pin.
 */
describe("builtinSurfaceInstalled", () => {
  it("registers an owner for every declared builtin surface", () => {
    for (const builtinId of PLUGIN_BUILTIN_SURFACE_IDS) {
      expect(builtinSurfaceOwner(builtinId).builtinId).toBe(builtinId);
    }
    expect(BUILTIN_SURFACE_OWNERS).toHaveLength(PLUGIN_BUILTIN_SURFACE_IDS.length);
  });

  it("is true only for the registered owner, installed and enabled", () => {
    expect(builtinSurfaceInstalled("linear", [{ pluginId: "ade-linear", enabled: true }])).toBe(true);
    expect(builtinSurfaceInstalled("linear", [{ pluginId: "ade-linear", enabled: false }])).toBe(false);
    expect(builtinSurfaceInstalled("linear", [])).toBe(false);
  });

  it("cannot be claimed by another plugin naming the surface", () => {
    expect(builtinSurfaceInstalled("graph", [{ pluginId: "someone-elses-graph", enabled: true }])).toBe(false);
  });

  it("accepts any iterable, so main can pass a registry map's values", () => {
    const records = new Map([["ade-history", { pluginId: "ade-history", enabled: true }]]);
    expect(builtinSurfaceInstalled("history", records.values())).toBe(true);
    expect(builtinSurfaceInstalled("graph", records.values())).toBe(false);
  });

  it("resolves owners by route and by plugin id", () => {
    expect(builtinSurfaceOwnerForRoute("/graph")?.ownerPluginId).toBe("ade-graph");
    expect(builtinSurfaceOwnerForRoute("/lanes")).toBeNull();
    expect(builtinSurfaceOwnerForPlugin("ade-app-control")?.builtinId).toBe("app-control");
    expect(builtinSurfaceOwnerForPlugin("some-community-plugin")).toBeNull();
  });

  it("throws on a surface with no registered owner rather than defaulting to visible", () => {
    expect(() => builtinSurfaceOwner("nope" as never)).toThrow(/No owner registered/);
  });
});
