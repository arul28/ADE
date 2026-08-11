import { describe, expect, it } from "vitest";

import { DEFAULT_PLUGIN_ICON, PLUGIN_ICON_NAMES, pluginIcon } from "./pluginIcons";

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
