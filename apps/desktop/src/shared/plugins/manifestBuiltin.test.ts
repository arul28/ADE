import { describe, expect, it } from "vitest";

import { PLUGIN_BUILTIN_SURFACE_IDS, parsePluginManifest } from "./manifest";

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

const graphSurface = { kind: "tab", id: "graph", title: "Graph", panelId: "main", builtin: "graph" };

describe("manifest builtin surfaces", () => {
  it("honours builtin on an official manifest", () => {
    const parsed = parsePluginManifest(manifest({ official: true, surfaces: [graphSurface] }));
    expect(parsed.errors).toEqual([]);
    expect(parsed.manifest?.surfaces[0]?.builtin).toBe("graph");
  });

  it("drops builtin from a manifest that does not claim official tier", () => {
    const parsed = parsePluginManifest(manifest({ surfaces: [graphSurface] }));
    expect(parsed.manifest?.surfaces[0]?.builtin).toBeUndefined();
    expect(parsed.warnings.join(" ")).toContain("official");
  });

  it("keeps the surface when builtin is refused", () => {
    // The plugin still declares a tab. Dropping the whole surface would turn a
    // rejected claim into a missing feature.
    const parsed = parsePluginManifest(manifest({ surfaces: [graphSurface] }));
    expect(parsed.manifest?.surfaces).toHaveLength(1);
    expect(parsed.manifest?.surfaces[0]).toMatchObject({ kind: "tab", id: "graph", panelId: "main" });
  });

  it("refuses a builtin name that is not a gateable tab", () => {
    const parsed = parsePluginManifest(manifest({
      official: true,
      surfaces: [{ ...graphSurface, builtin: "settings" }],
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
    ]);
  });
});
