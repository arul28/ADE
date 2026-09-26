import { describe, expect, it } from "vitest";
import {
  colorToCssString,
  composite,
  contrastRatio,
  isParsableColor,
  mixColors,
  parseColor,
  relativeLuminance,
  rgbToOklch,
  shiftLightness,
  toHex,
  withAlpha,
} from "./color";

describe("parseColor", () => {
  it("parses the hex notations a theme file may use", () => {
    expect(parseColor("#A78BFA")).toEqual({ r: 167, g: 139, b: 250, a: 1 });
    expect(parseColor("#abc")).toEqual({ r: 170, g: 187, b: 204, a: 1 });
    expect(parseColor("#0C0B10FF")).toEqual({ r: 12, g: 11, b: 16, a: 1 });
    expect(parseColor("#0C0B1080")).toEqual({ r: 12, g: 11, b: 16, a: 128 / 255 });
  });

  it("parses rgb() with comma or space separators and percentage alpha", () => {
    expect(parseColor("rgb(167, 139, 250)")).toEqual({ r: 167, g: 139, b: 250, a: 1 });
    expect(parseColor("rgb(167 139 250 / 50%)")).toEqual({ r: 167, g: 139, b: 250, a: 0.5 });
  });

  it("converts an oklch() colour into sRGB near its reference value", () => {
    const parsed = parseColor("oklch(0.74 0.12 293)");
    expect(parsed).not.toBeNull();
    // Round-trips through Oklch with the same perceptual lightness and hue.
    const oklch = rgbToOklch(parsed!);
    expect(oklch.l).toBeCloseTo(0.74, 1);
    expect(oklch.h).toBeCloseTo(293, 0);
  });

  it("rejects values it cannot understand rather than throwing", () => {
    expect(parseColor("not-a-colour")).toBeNull();
    expect(parseColor("oklch(0.7 0.1)")).toBeNull();
    expect(parseColor(42)).toBeNull();
    expect(isParsableColor("#fff")).toBe(true);
    expect(isParsableColor("nope")).toBe(false);
  });

  it("reads transparent as zero-alpha black", () => {
    expect(parseColor("transparent")).toEqual({ r: 0, g: 0, b: 0, a: 0 });
  });
});

describe("contrastRatio", () => {
  it("matches WCAG's 21:1 for black on white", () => {
    expect(contrastRatio({ r: 0, g: 0, b: 0 }, { r: 255, g: 255, b: 255 })).toBeCloseTo(21, 0);
  });

  it("is symmetric", () => {
    const fg = { r: 12, g: 11, b: 16 };
    const bg = { r: 167, g: 139, b: 250 };
    expect(contrastRatio(fg, bg)).toBeCloseTo(contrastRatio(bg, fg), 5);
  });

  it("composites a translucent foreground over its backdrop before measuring", () => {
    const translucent = withAlpha({ r: 0, g: 0, b: 0 }, 0.5);
    expect(contrastRatio(translucent, { r: 255, g: 255, b: 255 }, { r: 255, g: 255, b: 255 }))
      .toBeLessThan(21);
    expect(composite(translucent, { r: 255, g: 255, b: 255 })).toEqual({ r: 128, g: 128, b: 128 });
  });
});

describe("colour transforms", () => {
  it("toHex clamps and pads", () => {
    expect(toHex({ r: 12, g: 11, b: 16 })).toBe("#0c0b10");
    expect(toHex({ r: 300, g: -5, b: 16 })).toBe("#ff0010");
  });

  it("mixColors interpolates in sRGB and reports alpha", () => {
    const mixed = mixColors({ r: 0, g: 0, b: 0 }, { r: 255, g: 255, b: 255 }, 0.5);
    expect(mixed.r).toBe(128);
    expect(colorToCssString(mixed)).toBe("#808080");
    const translucent = mixColors(withAlpha({ r: 0, g: 0, b: 0 }, 1), withAlpha({ r: 0, g: 0, b: 0 }, 0), 0.5);
    expect(translucent.a).toBeCloseTo(0.5, 2);
    expect(colorToCssString(translucent)).toMatch(/^rgba\(/);
  });

  it("shiftLightness moves a colour toward white and black", () => {
    const base = { r: 128, g: 128, b: 128 };
    expect(relativeLuminance(shiftLightness(base, 0.2))).toBeGreaterThan(relativeLuminance(base));
    expect(relativeLuminance(shiftLightness(base, -0.2))).toBeLessThan(relativeLuminance(base));
  });
});
