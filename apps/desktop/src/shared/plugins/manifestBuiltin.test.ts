import { describe, expect, it } from "vitest";

import {
  PLUGIN_BUILTIN_SURFACE_IDS,
  PLUGIN_BUILTIN_SURFACE_MOBILE,
  PLUGIN_BUILTIN_SURFACE_PRESENCE,
  parsePluginManifest,
  type PluginBuiltinSurfaceId,
} from "./manifest";

/**
 * `surfaces[].builtin` — the field that lets a plugin gate a compiled-in tab.
 *
 * The rules it has to keep are all refusals, so they are tested as refusals:
 * an unofficial manifest cannot claim one, no manifest can invent one, and
 * neither refusal may cost the surface itself — a plugin whose `builtin` was
 * dropped is still a plugin with a tab.
 */

function manifest(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    name: "some-plugin",
    version: "1.0.0",
    displayName: "Some plugin",
    description: "",
    vocabVersion: 1,
    ...overrides,
  };
}

const iosSurface = { kind: "tab", id: "sim", title: "iOS Simulator", panelId: "main", builtin: "ios" };

describe("manifest builtin surfaces", () => {
  it("honours builtin on an official manifest", () => {
    const parsed = parsePluginManifest(manifest({ official: true, surfaces: [iosSurface] }));
    expect(parsed.errors).toEqual([]);
    expect(parsed.manifest?.surfaces[0]?.builtin).toBe("ios");
  });

  it("drops builtin from a manifest that does not claim official tier", () => {
    const parsed = parsePluginManifest(manifest({ surfaces: [iosSurface] }));
    expect(parsed.manifest?.surfaces[0]?.builtin).toBeUndefined();
    expect(parsed.warnings.join(" ")).toContain("official");
  });

  it("keeps the surface when builtin is refused", () => {
    // The plugin still declares a tab. Dropping the whole surface would turn a
    // rejected claim into a missing feature.
    const parsed = parsePluginManifest(manifest({ surfaces: [iosSurface] }));
    expect(parsed.manifest?.surfaces).toHaveLength(1);
    expect(parsed.manifest?.surfaces[0]).toMatchObject({ kind: "tab", id: "sim", panelId: "main" });
  });

  it("refuses a builtin name that is not a gateable tab", () => {
    const parsed = parsePluginManifest(manifest({
      official: true,
      surfaces: [{ ...iosSurface, builtin: "settings" }],
    }));
    expect(parsed.manifest?.surfaces[0]?.builtin).toBeUndefined();
    expect(parsed.warnings.join(" ")).toContain("not a gateable built-in tab");
  });

  it("leaves ordinary surfaces without the field", () => {
    const parsed = parsePluginManifest(manifest({
      official: true,
      surfaces: [{ kind: "tab", id: "notes", title: "Notes", panelId: "main" }],
    }));
    expect(parsed.manifest?.surfaces[0]).not.toHaveProperty("builtin");
  });

  /**
   * A gated built-in draws compiled code, so whether it appears on the phone is
   * a fact about what iOS ships — not something a manifest gets to assert.
   */
  it("clamps mobile to what the phone has a page for", () => {
    const parsed = parsePluginManifest(manifest({
      official: true,
      surfaces: [{ ...iosSurface, mobile: true }],
    }));
    expect(parsed.errors).toEqual([]);
    expect(parsed.manifest?.surfaces[0]?.mobile).toBe(false);
    expect(parsed.warnings.join(" ")).toContain("no page for");
  });

  it("has no mobile-capable built-in left for a manifest to name", () => {
    // A fact about the product, pinned so it cannot change by accident. The
    // ceiling table records two surfaces the phone really does draw — `linear`
    // and `cursor-cloud` — and BOTH of them supersede, so neither may appear in
    // a `surfaces[].builtin` field. Every built-in a manifest can still name is
    // one the phone has no page for, which is why the only mobile rule that
    // runs today is the clamp above.
    for (const [builtinId, hasPage] of Object.entries(PLUGIN_BUILTIN_SURFACE_MOBILE)) {
      if (!hasPage) continue;
      expect(PLUGIN_BUILTIN_SURFACE_PRESENCE[builtinId as PluginBuiltinSurfaceId], builtinId)
        .toBe("supersedes");
    }
  });

  it("refuses the claim before the ceiling is ever consulted", () => {
    // The order matters. `linear` is mobile-capable, so a reader might expect
    // `mobile: true` to survive here. It does not: the surface parser drops the
    // `builtin` field first, because the surface supersedes, and what is left is
    // an ordinary tab that takes the ordinary default.
    const parsed = parsePluginManifest(manifest({
      official: true,
      surfaces: [{ kind: "tab", id: "issues", title: "Linear", panelId: "issues", builtin: "linear" }],
    }));
    expect(parsed.manifest?.surfaces[0]?.builtin).toBeUndefined();
    expect(parsed.warnings.join(" ")).toContain("superseded surface");
  });

  it("refuses builtin on Graph because that surface supersedes", () => {
    const parsed = parsePluginManifest(manifest({
      official: true,
      surfaces: [{ kind: "tab", id: "graph", title: "Graph", panelId: "graph", builtin: "graph" }],
    }));
    expect(parsed.manifest?.surfaces[0]?.builtin).toBeUndefined();
    expect(parsed.warnings.join(" ")).toContain("superseded surface");
  });

  it("gives a refused builtin claim the ordinary surface default", () => {
    // The `builtin` was dropped, so what is left is a plain tab — and a plain
    // tab is mobile-capable. The clamp must not outlive the claim it clamped.
    const parsed = parsePluginManifest(manifest({ surfaces: [iosSurface] }));
    expect(parsed.manifest?.surfaces[0]?.builtin).toBeUndefined();
    expect(parsed.manifest?.surfaces[0]?.mobile).toBe(true);
  });

  it("keeps the mobile table aligned with the gateable list", () => {
    expect(Object.keys(PLUGIN_BUILTIN_SURFACE_MOBILE).sort()).toEqual([...PLUGIN_BUILTIN_SURFACE_IDS].sort());
    expect(PLUGIN_BUILTIN_SURFACE_MOBILE.linear).toBe(true);
  });

  it("keeps the gateable list closed", () => {
    // A new entry here is a platform change: every client has to grow an owner,
    // an entry-point gate and a route or pane for it, so the list moving is
    // worth a failing test rather than a review comment.
    expect([...PLUGIN_BUILTIN_SURFACE_IDS]).toEqual([
      "graph",
      "review",
      "history",
      "linear",
      "ios",
      "app-control",
      "cursor-cloud",
    ]);
  });
});
