import { describe, expect, it } from "vitest";
import {
  ADE_TOKENS,
  COLORS,
  FONT_SIZES,
  LABEL_STYLE,
  MONO_FONT,
  RADII,
  SANS_FONT,
  SPACING,
  adeVar,
  cardStyle,
  floatingPane,
  healthColor,
  laneRailTint,
  laneSurfaceTint,
  outlineButton,
  primaryButton,
  tokens,
} from "../src/index";

describe("token references", () => {
  it("resolves through --ade-* with the desktop --color-* as the fallback", () => {
    // This is the contract that keeps ONE module serving both hosts. Break it
    // and either the desktop loses its palette or plugin pages lose theirs.
    expect(adeVar("--ade-bg", "color-bg")).toBe("var(--ade-bg, var(--color-bg))");
    expect(COLORS.pageBg).toBe("var(--ade-bg, var(--color-bg))");
    expect(COLORS.textPrimary).toBe("var(--ade-fg, var(--color-fg))");
    expect(COLORS.accent).toBe("var(--ade-accent, var(--color-accent))");
    expect(COLORS.danger).toBe("var(--ade-error, var(--color-error))");
    expect(SANS_FONT).toBe("var(--ade-font-sans, var(--font-sans))");
    expect(MONO_FONT).toBe("var(--ade-font-mono, var(--font-mono))");
  });

  it("names every colour token it reads", () => {
    const referenced = new Set<string>();
    for (const value of Object.values(COLORS)) {
      for (const match of value.matchAll(/var\((--ade-[a-z-]+)/g)) referenced.add(match[1]!);
    }
    for (const token of referenced) expect(ADE_TOKENS).toContain(token);
  });

  it("exposes a tokens map keyed by token name", () => {
    expect(tokens["--ade-accent"]).toBe("var(--ade-accent)");
    expect(Object.keys(tokens)).toHaveLength(ADE_TOKENS.length);
  });

  it("keeps the desktop scales", () => {
    expect(SPACING).toEqual({ xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 });
    expect(FONT_SIZES).toEqual({ xs: 9, sm: 10, md: 11, base: 12, lg: 13, xl: 14 });
    expect(RADII).toEqual({ sm: 6, md: 8, lg: 12, xl: 16 });
    expect(LABEL_STYLE).toMatchObject({ fontSize: 11, fontWeight: 500, fontFamily: SANS_FONT });
  });
});

describe("style builders", () => {
  it("builds the primary and outline buttons at the app's metrics", () => {
    expect(primaryButton()).toMatchObject({ height: 32, padding: "0 14px", borderRadius: 8, border: "none" });
    expect(outlineButton()).toMatchObject({ height: 32, padding: "0 12px", borderRadius: 8 });
    expect(primaryButton({ height: 24 }).height).toBe(24);
  });

  it("keeps card and floating-pane chrome", () => {
    expect(cardStyle()).toMatchObject({ borderRadius: 16, padding: 20 });
    expect(floatingPane().boxShadow).toBe("var(--ade-shadow-panel, var(--shadow-panel))");
  });

  it("resolves a hex lane rail to a real rgba colour", () => {
    expect(laneRailTint("#A78BFA")).toBe("rgba(167, 139, 250, 0.25)");
    expect(laneRailTint("#abc", 50)).toBe("rgba(170, 187, 204, 0.5)");
    expect(laneRailTint(null)).toBe("rgba(255,255,255,0.07)");
    expect(laneRailTint("hsl(1 2% 3%)")).toContain("color-mix");
  });

  it("tints a lane surface and falls back when no colour is set", () => {
    expect(laneSurfaceTint(null).text).toBeNull();
    expect(laneSurfaceTint("#5E6AD2").text).toBe("#5E6AD2");
    expect(laneSurfaceTint("#5E6AD2", "soft").background).toContain("10%");
    expect(laneSurfaceTint("#5E6AD2", "default", 0.4).background).toContain("40%");
  });

  it("maps health to the semantic palette", () => {
    expect(healthColor("healthy")).toBe(COLORS.success);
    expect(healthColor("unhealthy")).toBe(COLORS.danger);
    expect(healthColor("anything-else")).toBe(COLORS.textDim);
  });
});

describe("entry points", () => {
  it("keeps the icon set and the markdown stack out of the barrel", async () => {
    // The reason this package is split at all: `@phosphor-icons/react` ships
    // without a `sideEffects` declaration, so anything that can see it through
    // the barrel keeps the WHOLE set. One design-token import taking that path
    // grew ADE's web client entry graph from 301 KB to 5,496 KB.
    const barrel = await import("../src/index");
    for (const name of ["LaneIcon", "BranchIcon", "Markdown", "SAFE_PREVIEW_SCHEMA"]) {
      expect(barrel, name).not.toHaveProperty(name);
    }
    expect(await import("../src/icons")).toHaveProperty("BranchIcon");
    expect(await import("../src/markdown")).toHaveProperty("Markdown");
  });

  it("serves the design tokens without React", async () => {
    const tokensEntry = await import("../src/tokens");
    expect(tokensEntry.COLORS).toBeTruthy();
    expect(tokensEntry.INPUT_CLS).toContain("ade-input");
    expect(tokensEntry).not.toHaveProperty("Button");
  });
});
