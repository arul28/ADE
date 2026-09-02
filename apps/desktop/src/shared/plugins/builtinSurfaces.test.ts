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
import {
  PLUGIN_BUILTIN_SURFACE_IDS,
  PLUGIN_BUILTIN_SURFACE_PRESENCE,
  type PluginBuiltinSurfaceId,
} from "./manifest";
import { coreSmartLinkBuiltinsOwnedBy, CORE_SMART_LINK_HOST_BUILTINS } from "./urlMatchers";

const CURSOR_CLOUD_INSTALLED = [{ pluginId: "ade-cursor-cloud", enabled: true }];
const LINEAR_INSTALLED = [{ pluginId: "ade-linear", enabled: true }];
const REVIEW_INSTALLED = [{ pluginId: "ade-review", enabled: true }];
const SUPERSEDED_SURFACES: readonly PluginBuiltinSurfaceId[] = [
  "linear",
  "cursor-cloud",
  "review",
  "history",
  "graph",
  "ios",
  "app-control",
];

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
 * Neither `ade-cursor-cloud` nor `ade-linear` makes its surface possible — ADE
 * shipped both compiled long before the plugin platform. Each plugin REPLACES
 * one, so its presence must take the built-in away rather than bring it. Every
 * assertion here is the mirror image of one above, and the pair is what stops a
 * future edit from collapsing the two relationships back into a single boolean.
 */
describe("builtinSurfaceDrawn", () => {
  it("has no enabling surfaces left", () => {
    for (const builtinId of PLUGIN_BUILTIN_SURFACE_IDS) {
      expect(builtinSurfacePresence(builtinId), builtinId).toBe("supersedes");
    }
  });

  it("puts shipped compiled surfaces on the supersedes polarity", () => {
    for (const builtinId of SUPERSEDED_SURFACES) {
      expect(builtinSurfacePresence(builtinId), builtinId).toBe("supersedes");
    }
  });

  it("draws the built-in Simulator until its plugin is installed and enabled", () => {
    expect(builtinSurfaceDrawn("ios", [])).toBe(true);
    expect(builtinSurfaceDrawn("ios", [{ pluginId: "ade-ios-sim", enabled: false }])).toBe(true);
    expect(builtinSurfaceDrawn("ios", [{ pluginId: "ade-ios-sim", enabled: true }])).toBe(false);
  });

  it("draws the built-in Electron Control until its plugin is installed and enabled", () => {
    expect(builtinSurfaceDrawn("app-control", [])).toBe(true);
    expect(builtinSurfaceDrawn("app-control", [{ pluginId: "ade-app-control", enabled: false }])).toBe(true);
    expect(builtinSurfaceDrawn("app-control", [{ pluginId: "ade-app-control", enabled: true }])).toBe(false);
  });

  it("draws the built-in Linear until its plugin is installed and enabled", () => {
    // The acceptance case in one assertion set: an ADE with no `ade-linear` is
    // the Linear integration it always was, and installing the plugin is the
    // only thing that stands the compiled one down.
    expect(builtinSurfaceDrawn("linear", [])).toBe(true);
    expect(builtinSurfaceDrawn("linear", [{ pluginId: "ade-linear", enabled: false }])).toBe(true);
    expect(builtinSurfaceDrawn("linear", CURSOR_CLOUD_INSTALLED)).toBe(true);
    expect(builtinSurfaceDrawn("linear", LINEAR_INSTALLED)).toBe(false);
  });

  it("draws the built-in Review until its plugin is installed and enabled", () => {
    expect(builtinSurfaceDrawn("review", [])).toBe(true);
    expect(builtinSurfaceDrawn("review", [{ pluginId: "ade-review", enabled: false }])).toBe(true);
    expect(builtinSurfaceDrawn("review", LINEAR_INSTALLED)).toBe(true);
    expect(builtinSurfaceDrawn("review", REVIEW_INSTALLED)).toBe(false);
  });

  it("draws the built-in History until its plugin is installed and enabled", () => {
    expect(builtinSurfaceDrawn("history", [])).toBe(true);
    expect(builtinSurfaceDrawn("history", [{ pluginId: "ade-history", enabled: false }])).toBe(true);
    expect(builtinSurfaceDrawn("history", REVIEW_INSTALLED)).toBe(true);
    expect(builtinSurfaceDrawn("history", [{ pluginId: "ade-history", enabled: true }])).toBe(false);
  });

  it("draws the built-in Graph until its plugin is installed and enabled", () => {
    expect(builtinSurfaceDrawn("graph", [])).toBe(true);
    expect(builtinSurfaceDrawn("graph", [{ pluginId: "ade-graph", enabled: false }])).toBe(true);
    expect(builtinSurfaceDrawn("graph", REVIEW_INSTALLED)).toBe(true);
    expect(builtinSurfaceDrawn("graph", [{ pluginId: "ade-graph", enabled: true }])).toBe(false);
  });

  it("draws the built-in Cursor Cloud until its plugin is installed and enabled", () => {
    expect(builtinSurfaceDrawn("cursor-cloud", [])).toBe(true);
    expect(builtinSurfaceDrawn("cursor-cloud", [{ pluginId: "ade-cursor-cloud", enabled: false }])).toBe(true);
    expect(builtinSurfaceDrawn("cursor-cloud", LINEAR_INSTALLED)).toBe(true);
    expect(builtinSurfaceDrawn("cursor-cloud", CURSOR_CLOUD_INSTALLED)).toBe(false);
  });

  it("hides every compiled surface once its owner is installed", () => {
    const both = [...LINEAR_INSTALLED, { pluginId: "ade-ios-sim", enabled: true }];
    expect(builtinSurfaceDrawn("ios", both)).toBe(false);
    expect(builtinSurfaceDrawn("linear", both)).toBe(false);
  });

  it("cannot be superseded by another plugin naming the owner's surface", () => {
    expect(builtinSurfaceDrawn("cursor-cloud", [{ pluginId: "someone-elses-cloud", enabled: true }])).toBe(true);
    expect(builtinSurfaceDrawn("linear", [{ pluginId: "someone-elses-linear", enabled: true }])).toBe(true);
    expect(builtinSurfaceDrawn("review", [{ pluginId: "someone-elses-review", enabled: true }])).toBe(true);
    expect(builtinSurfaceDrawn("graph", [{ pluginId: "someone-elses-graph", enabled: true }])).toBe(true);
  });

  it("keeps the presence table keyed by the closed id list", () => {
    expect(Object.keys(PLUGIN_BUILTIN_SURFACE_PRESENCE).sort())
      .toEqual([...PLUGIN_BUILTIN_SURFACE_IDS].sort());
  });
});

/**
 * Withholding a verb is not refusing it.
 *
 * Three surfaces take this softer form. Cursor Cloud's verbs share the `ai`
 * domain with the model picker and every API-key verb, so refusing the domain
 * would take the picker down. Linear and Review have domains of their own and
 * still may not refuse them, because they SUPERSEDE: ADE compiled those verbs
 * and still answers them for the chats and automations already using them.
 */
describe("hiddenBuiltinActionNames", () => {
  it("hides nothing while both built-in surfaces are the ones in the product", () => {
    expect(hiddenBuiltinActionNames([]).size).toBe(0);
    expect(hiddenBuiltinActionNames([{ pluginId: "ade-ios-sim", enabled: true }]).size).toBe(0);
  });

  it("hides every Cursor Cloud verb once the plugin owns the surface", () => {
    const hidden = hiddenBuiltinActionNames(CURSOR_CLOUD_INSTALLED);
    expect(hidden.has("ai.getCursorCloudFleet")).toBe(true);
    expect(hidden.has("ai.createCursorCloudRun")).toBe(true);
  });

  it("hides every compiled Linear verb once the plugin owns the surface", () => {
    const hidden = hiddenBuiltinActionNames(LINEAR_INSTALLED);
    expect(hidden.has("linear_issue_tracker.listIssues")).toBe(true);
    expect(hidden.has("linear_issue_tracker.createComment")).toBe(true);
    expect(hidden.has("linear_oauth.startSession")).toBe(true);
    expect(hidden.has("linear_credentials.setToken")).toBe(true);
    // Nothing else moves: Cursor Cloud is a separate surface with its own owner.
    expect(hidden.has("ai.getCursorCloudFleet")).toBe(false);
  });

  it("hides every compiled Review verb once the plugin owns the surface", () => {
    const hidden = hiddenBuiltinActionNames(REVIEW_INSTALLED);
    expect(hidden.has("review.startRun")).toBe(true);
    expect(hidden.has("review.listRuns")).toBe(true);
    expect(hidden.has("review.recordFeedback")).toBe(true);
    expect(hidden.has("ai.getCursorCloudFleet")).toBe(false);
  });

  it("hides every superseded set when those plugins own their surfaces", () => {
    const hidden = hiddenBuiltinActionNames([
      ...LINEAR_INSTALLED,
      ...CURSOR_CLOUD_INSTALLED,
      ...REVIEW_INSTALLED,
    ]);
    expect(hidden.size).toBe(gatedBuiltinActionNames().length);
  });

  it("keeps the Linear verbs DISPATCHING, because nothing refuses their domains", () => {
    // The distinction the whole `supersedes` polarity rests on. A plugin that
    // replaces a UI must not fail the calls an existing chat is part-way
    // through, so no `linear_*` domain may appear in the refusal list — however
    // many of its verbs leave the catalog.
    const owner = builtinSurfaceOwner("linear");
    expect(owner.actionDomains).toEqual([]);
    expect(owner.actionNames.length).toBeGreaterThan(0);
    for (const domain of BUILTIN_SURFACE_OWNERS.flatMap((entry) => entry.actionDomains)) {
      expect(domain.startsWith("linear")).toBe(false);
    }
  });

  it("never hides the Cursor connection verbs the CLI and chat provider still need", () => {
    const hidden = hiddenBuiltinActionNames(CURSOR_CLOUD_INSTALLED);
    for (const name of ["ai.cursorAuthStatus", "ai.cursorAuthLogin", "ai.getStatus"]) {
      expect(hidden.has(name)).toBe(false);
    }
  });

  it("names every gated verb, and never names one inside a refused domain", () => {
    const domains = new Set(BUILTIN_SURFACE_OWNERS.flatMap((owner) => owner.actionDomains));
    for (const name of gatedBuiltinActionNames()) {
      expect(name).toMatch(/^[a-z_]+\.[A-Za-z]+$/);
      // A verb cannot be both withheld by name and refused by domain: the two
      // gates would disagree about whether the call is allowed.
      expect(domains.has(name.split(".")[0]!)).toBe(false);
    }
  });
});

/**
 * The smart-link relaxation keys on OWNERSHIP, not on the `builtin` field.
 *
 * `urlMatchers.ts` used to hand-mirror which package owns each surface behind a
 * core smart-link host, because `builtinSurfaces.ts` imports it and the arrow
 * could not run back; two cases here pinned the mirror against the real table.
 * Both owner maps now read `PLUGIN_BUILTIN_SURFACE_OWNER_IDS` out of
 * `builtinSurfaceRegistry.ts`, so there is no second copy left to drift and the
 * pinning cases are gone with it. What is still worth asserting is the OUTPUT:
 * a drift here costs `ade-linear` the `linear.app` matcher it ships, silently.
 */
describe("core smart-link host ownership", () => {
  it("hands each built-in a core host unlocks to its registered owner", () => {
    for (const builtinId of Object.values(CORE_SMART_LINK_HOST_BUILTINS)) {
      const owner = builtinSurfaceOwner(builtinId);
      expect(coreSmartLinkBuiltinsOwnedBy(owner.ownerPluginId), builtinId).toContain(builtinId);
    }
  });

  it("hands nothing to a package that owns no unlocked surface", () => {
    const unlocked = new Set<string>(Object.values(CORE_SMART_LINK_HOST_BUILTINS));
    for (const owner of BUILTIN_SURFACE_OWNERS) {
      if (unlocked.has(owner.builtinId)) continue;
      expect(coreSmartLinkBuiltinsOwnedBy(owner.ownerPluginId), owner.ownerPluginId).toEqual([]);
    }
  });
});
