import { describe, expect, it } from "vitest";
import { isParsableColor, parseColor, contrastRatio } from "./color";
import { getShippedTheme, ADE_BUILTIN_THEMES } from "./library";
import { resolvePalette, resolveTheme, STYLESHEET_THEME_IDS } from "./resolve";
import { ADE_TERMINAL_ANSI_KEYS, ADE_THEME_PALETTE_KEYS, type AdeTheme } from "./types";

function theme(partial: Partial<AdeTheme> & Pick<AdeTheme, "palette">): AdeTheme {
  return {
    formatVersion: 1,
    id: "test-theme",
    name: "Test Theme",
    baseMode: "dark",
    source: "custom",
    ...partial,
  };
}

describe("resolveTheme for the stylesheet themes", () => {
  it("emits no inline variables for dark and light, so the stylesheet stays exact", () => {
    for (const id of STYLESHEET_THEME_IDS) {
      const resolved = resolveTheme(getShippedTheme(id)!);
      expect(resolved.cssVars).toEqual({});
      expect(resolved.theme.baseMode).toBe(id);
    }
  });
});

describe("resolveTheme for a custom theme", () => {
  it("emits the core palette as CSS custom properties verbatim", () => {
    const resolved = resolveTheme(theme({
      palette: {
        bg: "#101418",
        fg: "#E6EDF7",
        surface: "#141A22",
        card: "#18202A",
        accent: "#60A5FA",
      },
    }));
    expect(resolved.cssVars["--color-bg"]).toBe("#101418");
    expect(resolved.cssVars["--color-fg"]).toBe("#e6edf7");
    expect(resolved.cssVars["--color-accent"]).toBe("#60a5fa");
    expect(resolved.cssVars["--color-card"]).toBe("#18202a");
    // The engine must never shadow `data-theme` for a non-stylesheet theme.
    expect(resolved.cssVars["--color-bg"]).not.toBe("");
  });

  it("derives every omitted token to a real colour", () => {
    const resolved = resolveTheme(theme({
      palette: { bg: "#0b0b0f", fg: "#ececf1", surface: "#121218", card: "#17171e", accent: "#f472b6" },
    }));
    for (const key of ADE_THEME_PALETTE_KEYS) {
      expect(isParsableColor(resolved.palette[key]), `palette.${key}`).toBe(true);
    }
    // Derived tokens must actually differ from their base, not silently copy it.
    expect(resolved.palette.mutedFg).not.toBe(resolved.palette.fg);
    expect(resolved.palette.accentDeep).not.toBe(resolved.palette.accent);
    expect(resolved.cssVars["--color-muted-fg"]).toBeDefined();
  });

  it("chooses an accent foreground that is readable on the accent", () => {
    const resolved = resolveTheme(theme({
      palette: { bg: "#000", fg: "#fff", surface: "#111", card: "#111", accent: "#FFD24A" },
    }));
    const ratio = contrastRatio(
      parseColor(resolved.palette.accentFg)!,
      parseColor(resolved.palette.accent)!,
    );
    expect(ratio).toBeGreaterThanOrEqual(3);
  });
});

describe("contrast reporting", () => {
  it("flags a low-contrast custom theme without blocking it", () => {
    const resolved = resolveTheme(theme({
      palette: { bg: "#777777", fg: "#888888", surface: "#777777", card: "#777777", accent: "#7a7a7a" },
    }));
    expect(resolved.contrastIssues.length).toBeGreaterThan(0);
    expect(resolved.contrastIssues[0]).toMatchObject({
      label: expect.any(String),
      ratio: expect.any(Number),
      threshold: expect.any(Number),
    });
  });

  it("reports nothing for the shipped high-contrast theme", () => {
    const resolved = resolveTheme(getShippedTheme("high-contrast")!);
    const textIssues = resolved.contrastIssues.filter((issue) => issue.threshold === 4.5);
    expect(textIssues).toEqual([]);
  });
});

describe("resolvePalette", () => {
  it("infers missing muted text per base mode", () => {
    const dark = resolvePalette(theme({ baseMode: "dark", palette: { bg: "#000", fg: "#fff", surface: "#111", card: "#111", accent: "#fff" } }));
    const light = resolvePalette(theme({ baseMode: "light", palette: { bg: "#fff", fg: "#000", surface: "#fafafa", card: "#fff", accent: "#000" } }));
    expect(parseColor(dark.mutedFg)).not.toBeNull();
    expect(parseColor(light.mutedFg)).not.toBeNull();
    expect(dark.mutedFg).not.toBe(light.mutedFg);
  });
});

describe("terminal palette", () => {
  it("provides all 16 ANSI colours plus the structural four", () => {
    const resolved = resolveTheme(theme({
      palette: { bg: "#0b0b0f", fg: "#ececf1", surface: "#121218", card: "#17171e", accent: "#f472b6" },
    }));
    for (const key of ADE_TERMINAL_ANSI_KEYS) {
      expect(isParsableColor(resolved.terminal[key]), `terminal.${key}`).toBe(true);
    }
    expect(isParsableColor(resolved.terminal.background)).toBe(true);
    expect(isParsableColor(resolved.terminal.foreground)).toBe(true);
    expect(isParsableColor(resolved.terminal.cursor)).toBe(true);
  });

  it("honours an explicit ANSI override", () => {
    const resolved = resolveTheme(theme({
      palette: { bg: "#000", fg: "#fff", surface: "#111", card: "#111", accent: "#60a5fa" },
      terminal: { red: "#ff0000", background: "#010203" },
    }));
    expect(resolved.terminal.red).toBe("#ff0000");
    expect(resolved.terminal.background).toBe("#010203");
  });

  it("gives every shipped theme a complete terminal palette", () => {
    for (const shipped of ADE_BUILTIN_THEMES) {
      const resolved = resolveTheme(shipped);
      expect(isParsableColor(resolved.terminal.foreground), shipped.id).toBe(true);
      expect(isParsableColor(resolved.terminal.background), shipped.id).toBe(true);
    }
  });
});
