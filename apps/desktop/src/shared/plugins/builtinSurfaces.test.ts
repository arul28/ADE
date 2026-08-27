import { describe, expect, it } from "vitest";

import {
  BUILTIN_SURFACE_OWNERS,
  builtinSurfaceDrawn,
  builtinSurfaceInstalled,
  builtinSurfaceOwner,
  builtinSurfaceOwnerForPlugin,
  builtinSurfaceOwnerForRoute,
  builtinSurfacePresence,
  gatedBuiltinActionNames,
  hiddenBuiltinActionNames,
} from "./builtinSurfaces";
import { PLUGIN_BUILTIN_SURFACE_IDS, PLUGIN_BUILTIN_SURFACE_PRESENCE } from "./manifest";

const CURSOR_CLOUD_INSTALLED = [{ pluginId: "ade-cursor-cloud", enabled: true }];

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

/**
 * The second polarity, and the reason it exists.
 *
 * `ade-cursor-cloud` does not make a Cursor Cloud surface possible — ADE has
 * shipped one compiled for months. The plugin REPLACES it, so its presence must
 * take the built-in away rather than bring it. Every assertion here is the
 * mirror image of one above, and the pair is what stops a future edit from
 * collapsing the two relationships back into a single boolean.
 */
describe("builtinSurfaceDrawn", () => {
  it("keeps every existing surface on the enables polarity", () => {
    for (const builtinId of PLUGIN_BUILTIN_SURFACE_IDS) {
      if (builtinId === "cursor-cloud") continue;
      expect(builtinSurfacePresence(builtinId)).toBe("enables");
    }
    expect(builtinSurfacePresence("cursor-cloud")).toBe("supersedes");
  });

  it("agrees with builtinSurfaceInstalled for an enabled surface", () => {
    expect(builtinSurfaceDrawn("linear", [{ pluginId: "ade-linear", enabled: true }])).toBe(true);
    expect(builtinSurfaceDrawn("linear", [{ pluginId: "ade-linear", enabled: false }])).toBe(false);
    expect(builtinSurfaceDrawn("linear", [])).toBe(false);
  });

  it("draws the built-in Cursor Cloud until its plugin is installed and enabled", () => {
    expect(builtinSurfaceDrawn("cursor-cloud", [])).toBe(true);
    expect(builtinSurfaceDrawn("cursor-cloud", [{ pluginId: "ade-cursor-cloud", enabled: false }])).toBe(true);
    expect(builtinSurfaceDrawn("cursor-cloud", [{ pluginId: "ade-linear", enabled: true }])).toBe(true);
    expect(builtinSurfaceDrawn("cursor-cloud", CURSOR_CLOUD_INSTALLED)).toBe(false);
  });

  it("cannot be superseded by another plugin naming the owner's surface", () => {
    expect(builtinSurfaceDrawn("cursor-cloud", [{ pluginId: "someone-elses-cloud", enabled: true }])).toBe(true);
  });

  it("keeps the presence table keyed by the closed id list", () => {
    expect(Object.keys(PLUGIN_BUILTIN_SURFACE_PRESENCE).sort())
      .toEqual([...PLUGIN_BUILTIN_SURFACE_IDS].sort());
  });
});

/**
 * Cursor Cloud's verbs share the `ai` domain with the model picker and every
 * API-key verb, so they are withheld one name at a time rather than by refusing
 * the domain. These pin the boundary: the fleet verbs leave the catalog, the
 * Cursor connection verbs never do.
 */
describe("hiddenBuiltinActionNames", () => {
  it("hides nothing while the built-in surface is the one in the product", () => {
    expect(hiddenBuiltinActionNames([]).size).toBe(0);
    expect(hiddenBuiltinActionNames([{ pluginId: "ade-linear", enabled: true }]).size).toBe(0);
  });

  it("hides every Cursor Cloud verb once the plugin owns the surface", () => {
    const hidden = hiddenBuiltinActionNames(CURSOR_CLOUD_INSTALLED);
    expect(hidden.has("ai.getCursorCloudFleet")).toBe(true);
    expect(hidden.has("ai.createCursorCloudRun")).toBe(true);
    expect(hidden.size).toBe(gatedBuiltinActionNames().length);
  });

  it("never hides the Cursor connection verbs the CLI and chat provider still need", () => {
    const hidden = hiddenBuiltinActionNames(CURSOR_CLOUD_INSTALLED);
    for (const name of ["ai.cursorAuthStatus", "ai.cursorAuthLogin", "ai.getStatus"]) {
      expect(hidden.has(name)).toBe(false);
    }
  });

  it("names every gated verb inside a domain no plugin owns outright", () => {
    const domains = new Set(BUILTIN_SURFACE_OWNERS.flatMap((owner) => owner.actionDomains));
    for (const name of gatedBuiltinActionNames()) {
      expect(name).toMatch(/^[a-z_]+\.[A-Za-z]+$/);
      expect(domains.has(name.split(".")[0]!)).toBe(false);
    }
  });
});
