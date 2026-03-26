import { describe, expect, it } from "vitest";
import type { ChatSurfaceChipTone, ChatSurfaceMode } from "../../../shared/types";
import {
  CHAT_SURFACE_ACCENTS,
  chatChipToneClass,
  chatSurfaceVars,
  colorToRgba,
  resolveChatSurfaceAccent,
} from "./chatSurfaceTheme";

// ---------------------------------------------------------------------------
// colorToRgba
// ---------------------------------------------------------------------------

describe("colorToRgba", () => {
  it("converts a 6-digit hex color to rgba", () => {
    expect(colorToRgba("#FF8800", 1)).toBe("rgba(255, 136, 0, 1)");
  });

  it("converts a 6-digit hex color with fractional alpha", () => {
    expect(colorToRgba("#FF8800", 0.5)).toBe("rgba(255, 136, 0, 0.5)");
  });

  it("converts a 3-digit hex color by expanding digits", () => {
    // #F80 -> #FF8800
    expect(colorToRgba("#F80", 1)).toBe("rgba(255, 136, 0, 1)");
  });

  it("handles lowercase hex values", () => {
    expect(colorToRgba("#ff8800", 0.14)).toBe("rgba(255, 136, 0, 0.14)");
  });

  it("handles mixed case hex values", () => {
    expect(colorToRgba("#Ff8800", 0.28)).toBe("rgba(255, 136, 0, 0.28)");
  });

  it("handles alpha = 0", () => {
    expect(colorToRgba("#000000", 0)).toBe("rgba(0, 0, 0, 0)");
  });

  it("handles all-black hex", () => {
    expect(colorToRgba("#000000", 1)).toBe("rgba(0, 0, 0, 1)");
  });

  it("handles all-white hex", () => {
    expect(colorToRgba("#FFFFFF", 1)).toBe("rgba(255, 255, 255, 1)");
  });

  it("falls back to default color for invalid hex", () => {
    // normalizeHex defaults to "#71717A" for invalid input
    // #71717A => r=113, g=113, b=122
    expect(colorToRgba("not-a-color", 0.5)).toBe("rgba(113, 113, 122, 0.5)");
  });

  it("falls back for empty string", () => {
    expect(colorToRgba("", 1)).toBe("rgba(113, 113, 122, 1)");
  });

  it("handles hex with leading/trailing whitespace", () => {
    expect(colorToRgba("  #FF0000  ", 1)).toBe("rgba(255, 0, 0, 1)");
  });

  it("falls back for 4-digit hex (not valid shorthand)", () => {
    // #1234 is neither 3 nor 6 hex digits
    expect(colorToRgba("#1234", 1)).toBe("rgba(113, 113, 122, 1)");
  });

  it("falls back for 5-digit hex", () => {
    expect(colorToRgba("#12345", 1)).toBe("rgba(113, 113, 122, 1)");
  });

  it("correctly expands 3-digit shorthand #000", () => {
    expect(colorToRgba("#000", 1)).toBe("rgba(0, 0, 0, 1)");
  });

  it("correctly expands 3-digit shorthand #FFF", () => {
    expect(colorToRgba("#FFF", 1)).toBe("rgba(255, 255, 255, 1)");
  });

  it("correctly expands 3-digit shorthand #abc", () => {
    // #abc -> #aabbcc => r=170, g=187, b=204
    expect(colorToRgba("#abc", 1)).toBe("rgba(170, 187, 204, 1)");
  });
});

// ---------------------------------------------------------------------------
// resolveChatSurfaceAccent
// ---------------------------------------------------------------------------

describe("resolveChatSurfaceAccent", () => {
  it("returns mode-default accent when no custom color is provided", () => {
    expect(resolveChatSurfaceAccent("standard")).toBe("#71717A");
    expect(resolveChatSurfaceAccent("resolver")).toBe("#F97316");
    expect(resolveChatSurfaceAccent("mission-thread")).toBe("#38BDF8");
    expect(resolveChatSurfaceAccent("mission-feed")).toBe("#22C55E");
  });

  it("returns mode-default accent when accentColor is null", () => {
    expect(resolveChatSurfaceAccent("resolver", null)).toBe("#F97316");
  });

  it("returns mode-default accent when accentColor is undefined", () => {
    expect(resolveChatSurfaceAccent("resolver", undefined)).toBe("#F97316");
  });

  it("returns mode-default accent when accentColor is empty string", () => {
    expect(resolveChatSurfaceAccent("resolver", "")).toBe("#F97316");
  });

  it("returns mode-default accent when accentColor is whitespace only", () => {
    expect(resolveChatSurfaceAccent("resolver", "   ")).toBe("#F97316");
  });

  it("returns the custom color normalized when it is a valid 6-digit hex", () => {
    expect(resolveChatSurfaceAccent("standard", "#FF0000")).toBe("#FF0000");
  });

  it("expands a valid 3-digit hex custom color", () => {
    expect(resolveChatSurfaceAccent("standard", "#F00")).toBe("#FF0000");
  });

  it("normalizes invalid custom color to the default fallback hex", () => {
    expect(resolveChatSurfaceAccent("standard", "garbage")).toBe("#71717A");
  });

  it("trims custom color before normalizing", () => {
    expect(resolveChatSurfaceAccent("standard", "  #00FF00  ")).toBe("#00FF00");
  });
});

// ---------------------------------------------------------------------------
// chatSurfaceVars
// ---------------------------------------------------------------------------

describe("chatSurfaceVars", () => {
  it("returns an object with all expected CSS custom properties", () => {
    const vars = chatSurfaceVars("standard");
    const keys = Object.keys(vars);
    expect(keys).toContain("--chat-accent");
    expect(keys).toContain("--chat-accent-soft");
    expect(keys).toContain("--chat-accent-faint");
    expect(keys).toContain("--chat-accent-glow");
    expect(keys).toContain("--chat-surface-bg");
    expect(keys).toContain("--chat-surface-raised");
    expect(keys).toContain("--chat-panel-bg");
    expect(keys).toContain("--chat-panel-bg-strong");
    expect(keys).toContain("--chat-card-bg");
    expect(keys).toContain("--chat-card-bg-strong");
    expect(keys).toContain("--chat-panel-border");
    expect(keys).toContain("--chat-card-border");
    expect(keys).toContain("--chat-code-bg");
    expect(keys).toContain("--chat-code-border");
    expect(keys).toContain("--chat-code-fg");
    expect(keys).toContain("--chat-notice-bg");
    expect(keys).toContain("--chat-notice-border");
  });

  it("uses the mode-default accent color when no custom color is provided", () => {
    const vars = chatSurfaceVars("resolver");
    expect(vars["--chat-accent" as keyof typeof vars]).toBe("#F97316");
  });

  it("uses custom accent color when provided", () => {
    const vars = chatSurfaceVars("standard", "#FF0000");
    expect(vars["--chat-accent" as keyof typeof vars]).toBe("#FF0000");
  });

  it("derives soft/faint/glow from the resolved accent color", () => {
    const vars = chatSurfaceVars("standard", "#FF0000");
    expect(vars["--chat-accent-soft" as keyof typeof vars]).toBe("rgba(255, 0, 0, 0.14)");
    expect(vars["--chat-accent-faint" as keyof typeof vars]).toBe("rgba(255, 0, 0, 0.08)");
    expect(vars["--chat-accent-glow" as keyof typeof vars]).toBe("rgba(255, 0, 0, 0.28)");
  });

  it("has color-mix expressions for layout vars", () => {
    const vars = chatSurfaceVars("standard");
    const surfaceBg = vars["--chat-surface-bg" as keyof typeof vars] as string;
    expect(surfaceBg).toContain("color-mix");
  });

  it("produces different accent for different modes", () => {
    const standard = chatSurfaceVars("standard");
    const resolver = chatSurfaceVars("resolver");
    expect(standard["--chat-accent" as keyof typeof standard]).not.toBe(
      resolver["--chat-accent" as keyof typeof resolver],
    );
  });

  it("passes through null accentColor without error", () => {
    const vars = chatSurfaceVars("mission-feed", null);
    expect(vars["--chat-accent" as keyof typeof vars]).toBe("#22C55E");
  });
});

// ---------------------------------------------------------------------------
// chatChipToneClass
// ---------------------------------------------------------------------------

describe("chatChipToneClass", () => {
  it("returns a non-empty class string for every tone", () => {
    const tones: ChatSurfaceChipTone[] = ["accent", "success", "warning", "danger", "info", "muted"];
    for (const tone of tones) {
      const result = chatChipToneClass(tone);
      expect(result).toBeTruthy();
      expect(typeof result).toBe("string");
      expect(result.length).toBeGreaterThan(0);
    }
  });

  it("defaults to 'accent' tone when called with no argument", () => {
    const defaultResult = chatChipToneClass();
    const accentResult = chatChipToneClass("accent");
    expect(defaultResult).toBe(accentResult);
  });

  it("returns different class strings for different tones", () => {
    const success = chatChipToneClass("success");
    const danger = chatChipToneClass("danger");
    expect(success).not.toBe(danger);
  });

  it("accent tone references --chat-accent CSS variable", () => {
    const result = chatChipToneClass("accent");
    expect(result).toContain("--chat-accent");
  });

  it("success tone includes emerald classes", () => {
    const result = chatChipToneClass("success");
    expect(result).toContain("emerald");
  });

  it("warning tone includes amber classes", () => {
    const result = chatChipToneClass("warning");
    expect(result).toContain("amber");
  });

  it("danger tone includes red classes", () => {
    const result = chatChipToneClass("danger");
    expect(result).toContain("red");
  });

  it("info tone includes sky classes", () => {
    const result = chatChipToneClass("info");
    expect(result).toContain("sky");
  });

  it("muted tone includes white opacity classes", () => {
    const result = chatChipToneClass("muted");
    expect(result).toContain("white");
  });
});

// ---------------------------------------------------------------------------
// CHAT_SURFACE_ACCENTS
// ---------------------------------------------------------------------------

describe("CHAT_SURFACE_ACCENTS", () => {
  it("has entries for all four chat surface modes", () => {
    const modes: ChatSurfaceMode[] = ["standard", "resolver", "mission-thread", "mission-feed"];
    for (const mode of modes) {
      expect(CHAT_SURFACE_ACCENTS[mode]).toBeTruthy();
      expect(CHAT_SURFACE_ACCENTS[mode]).toMatch(/^#[0-9A-Fa-f]{6}$/);
    }
  });

  it("all accent values are distinct", () => {
    const values = Object.values(CHAT_SURFACE_ACCENTS);
    const unique = new Set(values);
    expect(unique.size).toBe(values.length);
  });
});
