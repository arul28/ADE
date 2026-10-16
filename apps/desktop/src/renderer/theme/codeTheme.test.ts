import { describe, expect, it } from "vitest";
import { getShippedTheme, normalizeAdeTheme, resolveTheme } from "../../shared/theme";
import {
  codeThemeFingerprint,
  monacoThemeData,
  shikiThemeData,
  shikiThemeName,
  usesStockCodeColors,
} from "./codeTheme";

const CORE = { bg: "#0b0b0f", fg: "#ececf1", surface: "#121218", card: "#17171e", accent: "#f472b6" };

describe("usesStockCodeColors", () => {
  it("is true only for the stylesheet dark and light themes", () => {
    expect(usesStockCodeColors(resolveTheme(getShippedTheme("dark")!))).toBe(true);
    expect(usesStockCodeColors(resolveTheme(getShippedTheme("light")!))).toBe(true);
    // Every other shipped theme, and every custom one, brings its own colours.
    expect(usesStockCodeColors(resolveTheme(getShippedTheme("terracotta-dark")!))).toBe(false);
    expect(usesStockCodeColors(resolveTheme(normalizeAdeTheme({ name: "Custom", palette: CORE })!))).toBe(false);
  });
});

describe("code surfaces follow the active theme", () => {
  it("paints Monaco tokens with the theme's syntax colours", () => {
    const resolved = resolveTheme(getShippedTheme("terracotta-dark")!);
    const theme = monacoThemeData(resolved);
    const keyword = theme.rules.find((rule) => rule.token === "keyword");
    // Monaco states token colours without the leading `#`.
    expect(keyword?.foreground).toBe(resolved.syntax.keyword.replace("#", ""));
    expect(theme.base).toBe("vs-dark");
  });

  it("writes Shiki token colours through the scope table an import reads", () => {
    const resolved = resolveTheme(getShippedTheme("terracotta-dark")!);
    const shiki = shikiThemeData(resolved);
    const keyword = shiki.tokenColors.find((rule) => rule.scope.includes("keyword.control"));
    expect(keyword?.settings.foreground).toBe(resolved.syntax.keyword);
    const comment = shiki.tokenColors.find((rule) => rule.scope.includes("comment"));
    expect(comment?.settings.fontStyle).toBe("italic");
    // The block paints the theme's own surface, not a stock one.
    expect(shiki.colors["editor.background"]).toBe(resolved.palette.surfaceRecessed);
    expect(shiki.type).toBe("dark");
  });
});

describe("codeThemeFingerprint", () => {
  it("changes when a theme's syntax colours change, so an edit repaints", () => {
    const base = normalizeAdeTheme({ name: "Edit", baseMode: "dark", palette: CORE })!;
    const edited = normalizeAdeTheme({ ...base, syntax: { ...base.syntax, keyword: "#cba6f7" } })!;
    const before = codeThemeFingerprint(resolveTheme(base));
    const after = codeThemeFingerprint(resolveTheme(edited));
    expect(after).not.toBe(before);
    // The chat cache and the Shiki theme name both move with it.
    expect(shikiThemeName(resolveTheme(edited))).not.toBe(shikiThemeName(resolveTheme(base)));
  });

  it("is stable for the same resolved theme", () => {
    const resolved = resolveTheme(getShippedTheme("terracotta-dark")!);
    expect(codeThemeFingerprint(resolved)).toBe(codeThemeFingerprint(resolved));
  });
});
