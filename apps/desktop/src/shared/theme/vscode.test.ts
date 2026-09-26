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

  it("reports the keys it could not map, including tokenColors", () => {
    const result = importVscodeTheme({
      colors: { "editor.background": "#000000", "workbench.totally.unknown": "#123456" },
      tokenColors: [{ scope: "comment", settings: { foreground: "#888888" } }],
    });
    expect(result!.unmapped).toContain("workbench.totally.unknown");
    expect(result!.unmapped).toContain("tokenColors");
    // A mapped key is never reported as unmapped.
    expect(result!.unmapped).not.toContain("editor.background");
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
