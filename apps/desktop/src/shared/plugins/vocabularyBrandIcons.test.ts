import { describe, expect, it } from "vitest";

import {
  PLUGIN_BRAND_ICONS_COLLECTION,
  PLUGIN_BRAND_ICON_LIMITS,
  isPluginBrandTokenName,
  parsePluginBrandGlyph,
  pluginBrandTokenKey,
  sanitizePluginBrandSvg,
} from "./vocabularyBrandIcons";
import { isReservedPluginCollection, PLUGIN_MEMORY_COLLECTION } from "./sdk";

const LINEAR_PATH =
  "M2.886 4.18A11.982 11.982 0 0 1 11.99 0C18.624 0 24 5.376 24 12.009c0 3.64-1.62 6.903-4.18 9.105L2.887 4.18ZM1.817 5.626l16.556 16.556c-.524.33-1.075.62-1.65.866L.951 7.277c.247-.575.537-1.126.866-1.65ZM.322 9.163l14.515 14.515c-.71.172-1.443.282-2.195.322L0 11.358a12 12 0 0 1 .322-2.195Zm-.17 4.862 9.823 9.824a12.02 12.02 0 0 1-9.824-9.824Z";

describe("plugin brand token keys", () => {
  it("reads the suffix off a well-formed brand token", () => {
    expect(pluginBrandTokenKey("brand:linear")).toBe("linear");
    expect(pluginBrandTokenKey("  Brand:Linear  ")).toBe("linear");
    expect(isPluginBrandTokenName("brand:linear")).toBe(true);
  });

  it("refuses a bare name, an empty suffix, and a suffix the token charset would not allow", () => {
    for (const name of ["linear", "brand:", "brand", "brand:Linear!", "brand:../x", "brand:a_b", null, ""]) {
      expect(pluginBrandTokenKey(name), String(name)).toBeNull();
      expect(isPluginBrandTokenName(name)).toBe(false);
    }
  });
});

describe("sanitizePluginBrandSvg", () => {
  it("keeps a path-only mono mark and its evenodd fill rule", () => {
    const glyph = sanitizePluginBrandSvg(
      `<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">`
      + `<path fill="currentColor" fill-rule="evenodd" d="${LINEAR_PATH}"/></svg>`,
    );
    expect(glyph).toEqual({
      viewBox: "0 0 24 24",
      paths: [{ d: LINEAR_PATH, evenodd: true }],
    });
  });

  it("defaults a missing viewBox and drops a mark that has no path", () => {
    expect(sanitizePluginBrandSvg('<svg><path d="M0 0 L24 24"/></svg>'))
      .toEqual({ viewBox: "0 0 24 24", paths: [{ d: "M0 0 L24 24" }] });
    expect(sanitizePluginBrandSvg('<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/></svg>'))
      .toBeNull();
  });

  it("refuses scripts, event handlers, remote use, and anything over the byte ceiling", () => {
    expect(sanitizePluginBrandSvg(`<svg><script>alert(1)</script><path d="M0 0"/></svg>`)).toBeNull();
    expect(sanitizePluginBrandSvg(`<svg><path d="M0 0" onclick="alert(1)"/></svg>`)).toBeNull();
    expect(sanitizePluginBrandSvg(`<svg><use href="https://evil.test/x.svg"/><path d="M0 0"/></svg>`)).toBeNull();
    expect(sanitizePluginBrandSvg(`<svg><path d="M0 0"/></svg>${"x".repeat(PLUGIN_BRAND_ICON_LIMITS.maxBytes)}`))
      .toBeNull();
  });
});

describe("parsePluginBrandGlyph", () => {
  it("re-admits a sanitizer result and refuses a smuggled markup path", () => {
    const glyph = sanitizePluginBrandSvg(`<svg viewBox="0 0 24 24"><path d="M0 0 L1 1"/></svg>`);
    expect(parsePluginBrandGlyph(glyph)).toEqual(glyph);
    expect(parsePluginBrandGlyph({ viewBox: "0 0 24 24", paths: [{ d: "<script>" }] })).toBeNull();
    expect(parsePluginBrandGlyph({ viewBox: "nope", paths: [{ d: "M0 0" }] })).toBeNull();
    expect(parsePluginBrandGlyph({ viewBox: "0 0 24 24", paths: [] })).toBeNull();
  });
});

describe("the reserved brand-icons collection", () => {
  it("is the same name the SDK refuses through collections.*", () => {
    expect(PLUGIN_BRAND_ICONS_COLLECTION).toBe("ade.brandIcons");
    expect(isReservedPluginCollection(PLUGIN_BRAND_ICONS_COLLECTION)).toBe(true);
    expect(isReservedPluginCollection(PLUGIN_MEMORY_COLLECTION)).toBe(true);
    expect(isReservedPluginCollection("issues")).toBe(false);
  });
});
