import { describe, expect, it } from "vitest";
import { isParsableColor } from "./color";
import { importVscodeTheme, VSCODE_COLOR_MAP } from "./vscode";
import { ADE_THEME_PALETTE_KEYS } from "./types";

describe("importVscodeTheme", () => {
  it("maps the workbench colours it understands and infers the base mode", () => {
    const result = importVscodeTheme({
      name: "My VS Code Theme",
      colors: {
        "editor.background": "#0b0b0f",
        "editor.foreground": "#ececf1",
        "sideBar.background": "#121218",
        "editorWidget.background": "#17171e",
        focusBorder: "#60a5fa",
        "button.foreground": "#07101f",
      },
    });
    expect(result).not.toBeNull();
    expect(result!.theme.name).toBe("My VS Code Theme");
    expect(result!.theme.source).toBe("vscode");
    expect(result!.theme.baseMode).toBe("dark");
    expect(result!.theme.palette.bg).toBe("#0b0b0f");
    expect(result!.theme.palette.fg).toBe("#ececf1");
    expect(result!.theme.palette.surface).toBe("#121218");
    expect(result!.theme.palette.card).toBe("#17171e");
    expect(result!.theme.palette.accent).toBe("#60a5fa");
    expect(result!.mapped).toContain("bg");
    expect(result!.mapped).toContain("accent");
  });

  it("infers a light base mode from a light editor background", () => {
    const result = importVscodeTheme({ colors: { "editor.background": "#ffffff", "editor.foreground": "#111111" } });
    expect(result!.theme.baseMode).toBe("light");
  });

  it("maps the terminal ANSI palette", () => {
    const result = importVscodeTheme({
      colors: { "editor.background": "#000000", "terminal.ansiRed": "#ff0000", "terminal.ansiBlue": "#0000ff" },
    });
    expect(result!.theme.terminal?.red).toBe("#ff0000");
    expect(result!.theme.terminal?.blue).toBe("#0000ff");
  });

  it("reports the keys it could not map, with tokenColors mapped into the syntax palette", () => {
    const result = importVscodeTheme({
      colors: { "editor.background": "#000000", "workbench.totally.unknown": "#123456" },
      tokenColors: [{ scope: "comment", settings: { foreground: "#888888" } }],
    });
    expect(result!.theme.syntax?.comment).toBe("#888888");
    expect(result!.syntaxMapped).toContain("comment");
    expect(result!.unmapped).toContain("workbench.totally.unknown");
    // tokenColors gave colours, so it is not reported as unmapped.
    expect(result!.unmapped).not.toContain("tokenColors");
    // A mapped key is never reported as unmapped.
    expect(result!.unmapped).not.toContain("editor.background");
  });

  it("reports tokenColors as unmapped only when none of it mapped", () => {
    const result = importVscodeTheme({
      colors: { "editor.background": "#000000" },
      tokenColors: [{ scope: "some.unknown.scope", settings: { foreground: "#888888" } }],
    });
    expect(result!.syntaxMapped).toEqual([]);
    expect(result!.unmapped).toContain("tokenColors");
  });

  it("resolves a scope by the longest match, the later rule winning a tie", () => {
    const result = importVscodeTheme({
      tokenColors: [
        { scope: "keyword", settings: { foreground: "#111111" } },
        { scope: "keyword.control", settings: { foreground: "#222222" } },
        { scope: "keyword.control", settings: { foreground: "#333333" } },
      ],
    })!;
    // `keyword` reads from `keyword.control` first; the longest scope wins and,
    // at equal specificity, the later rule wins — as VS Code resolves it.
    expect(result.theme.syntax?.keyword).toBe("#333333");
  });

  it("requires an exact entry for operator and property scopes", () => {
    const loose = importVscodeTheme({
      tokenColors: [{ scope: "keyword", settings: { foreground: "#111111" } }],
    })!;
    // A broad `keyword` entry must not paint operators.
    expect(loose.theme.syntax?.operator).toBeUndefined();

    const exactOperator = importVscodeTheme({
      tokenColors: [{ scope: "keyword.operator", settings: { foreground: "#333333" } }],
    })!;
    expect(exactOperator.theme.syntax?.operator).toBe("#333333");

    const looseProperty = importVscodeTheme({
      tokenColors: [{ scope: "variable", settings: { foreground: "#111111" } }],
    })!;
    // `variable` still maps the variable slot, but not a property.
    expect(looseProperty.theme.syntax?.variable).toBe("#111111");
    expect(looseProperty.theme.syntax?.property).toBeUndefined();

    const exactProperty = importVscodeTheme({
      tokenColors: [{ scope: "variable.other.property", settings: { foreground: "#444444" } }],
    })!;
    expect(exactProperty.theme.syntax?.property).toBe("#444444");
  });

  it("reads comments, trailing commas and a // inside a string", () => {
    const raw = `{
      // The name below carries the comment marker on purpose.
      "name": "A//B",
      "colors": {
        "editor.background": "#0b0b0f",
        /* the surface */ "editor.foreground": "#ececf1",
      },
    }`;
    const result = importVscodeTheme(raw)!;
    // A naive comment stripper would cut the name at `//` and fail to parse.
    expect(result.theme.name).toBe("A//B");
    expect(result.theme.palette.bg).toBe("#0b0b0f");
    expect(result.theme.palette.fg).toBe("#ececf1");
  });

  it("honours a declared type over the background colour", () => {
    const declared = importVscodeTheme({ type: "light", colors: { "editor.background": "#000000" } })!;
    expect(declared.theme.baseMode).toBe("light");
    const highContrast = importVscodeTheme({ type: "hc-black", colors: { "editor.background": "#ffffff" } })!;
    expect(highContrast.theme.baseMode).toBe("dark");
  });

  it("accepts a JSON string and rejects non-theme input", () => {
    expect(importVscodeTheme('{"colors":{"editor.background":"#000000"}}')).not.toBeNull();
    expect(importVscodeTheme({ hello: "world" })).toBeNull();
    expect(importVscodeTheme("not json")).toBeNull();
    expect(importVscodeTheme(null)).toBeNull();
  });

  it("only ever emits palette keys the engine knows", () => {
    const result = importVscodeTheme({
      colors: Object.fromEntries(
        Object.values(VSCODE_COLOR_MAP).flat().map((key, index) => [key, index % 2 === 0 ? "#101010" : "#eeeeee"]),
      ),
    })!;
    for (const key of Object.keys(result.theme.palette)) {
      expect(ADE_THEME_PALETTE_KEYS).toContain(key);
    }
    for (const value of Object.values(result.theme.palette)) {
      expect(isParsableColor(value)).toBe(true);
    }
  });
});
