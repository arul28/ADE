import { describe, expect, it } from "vitest";

import {
  DEFAULT_PLUGIN_ICON,
  PLUGIN_ICON_NAMES,
  PLUGIN_IDENTITY_COLORS,
  PLUGIN_IDENTITY_GLYPHS,
  pluginIcon,
  pluginIdentity,
} from "./pluginIcons";

/**
 * An icon name is untrusted manifest text, and the glyph it resolves to is
 * rendered in the tab rail — which sits ABOVE the route's error boundary, so a
 * value React refuses to render takes the app chrome down rather than one page.
 */
describe("pluginIcon", () => {
  it("never resolves an inherited property to a component", () => {
    for (const name of ["constructor", "__proto__", "toString", "hasOwnProperty", "valueOf"]) {
      expect(pluginIcon(name), `${name} escaped the allowlist`).toBe(DEFAULT_PLUGIN_ICON);
    }
  });

  it("degrades an unknown or absent name instead of returning nothing", () => {
    expect(pluginIcon("no-such-glyph")).toBe(DEFAULT_PLUGIN_ICON);
    expect(pluginIcon(null)).toBe(DEFAULT_PLUGIN_ICON);
    expect(pluginIcon("   ")).toBe(DEFAULT_PLUGIN_ICON);
  });

  it("resolves every published name, case- and space-insensitively", () => {
    expect(PLUGIN_ICON_NAMES.length).toBeGreaterThan(0);
    for (const name of PLUGIN_ICON_NAMES) {
      expect(pluginIcon(name), `${name} is published but does not resolve`).toBeTruthy();
    }
    expect(pluginIcon("  GEAR ")).toBe(pluginIcon("gear"));
  });
});

/**
 * A derived identity is not a decoration: it is what a plugin is recognised by
 * in a list, in the tab rail, and on someone else's machine. The only way all
 * three agree is for it to be computed from the id and nothing else.
 */
describe("pluginIdentity", () => {
  it("gives the same plugin the same look every time", () => {
    const first = pluginIdentity({ pluginId: "ade-graph" });
    const second = pluginIdentity({ pluginId: "ade-graph" });
    expect(second.Icon).toBe(first.Icon);
    expect(second.color).toBe(first.color);
  });

  it("draws from the curated lists and never from the raw palette", () => {
    // A colour that is not a token would not invert with the theme, which is the
    // one failure the identity palette exists to prevent.
    const ids = ["ade-graph", "ade-log-viewer", "ade-theme-ink", "a", "zzzz", "ade-review"];
    for (const pluginId of ids) {
      const identity = pluginIdentity({ pluginId });
      expect(PLUGIN_IDENTITY_COLORS, pluginId).toContain(identity.color);
      expect(identity.Icon, pluginId).toBeTruthy();
    }
  });

  it("spreads ids across the palette rather than parking them on one colour", () => {
    const colors = new Set<string>();
    const glyphs = new Set<unknown>();
    for (let index = 0; index < 64; index += 1) {
      const identity = pluginIdentity({ pluginId: `plugin-${index}` });
      colors.add(identity.color);
      glyphs.add(identity.Icon);
    }
    expect(colors.size).toBe(PLUGIN_IDENTITY_COLORS.length);
    expect(glyphs.size).toBeGreaterThan(PLUGIN_IDENTITY_GLYPHS.length / 2);
  });

  it("lets a published glyph and colour win, and ignores a glyph it does not have", () => {
    const named = pluginIdentity({ pluginId: "ade-graph", icon: "graph", accent: "#7C6FF0" });
    expect(named.Icon).toBe(pluginIcon("graph"));
    expect(named.color).toBe("#7C6FF0");

    // An unknown name falls back to the DERIVED glyph rather than to the puzzle
    // piece: the plugin still gets an identity, it just does not get that one.
    const unknown = pluginIdentity({ pluginId: "ade-graph", icon: "no-such-glyph" });
    expect(unknown.Icon).toBe(pluginIdentity({ pluginId: "ade-graph" }).Icon);
  });

  it("carries a published image through and treats blank as absent", () => {
    expect(pluginIdentity({ pluginId: "x", iconUrl: "https://example.test/i.png" }).imageUrl)
      .toBe("https://example.test/i.png");
    expect(pluginIdentity({ pluginId: "x", iconUrl: "   " }).imageUrl).toBeNull();
    expect(pluginIdentity({ pluginId: "x" }).imageUrl).toBeNull();
  });
});
