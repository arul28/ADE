import { describe, expect, it } from "vitest";

import {
  ADE_CHAT_TOKENS,
  createTheme,
  defaultTheme,
  themeToCss,
} from "../src/theme/createTheme";

describe("createTheme", () => {
  it("always emits the complete token set", () => {
    const theme = createTheme();
    expect(Object.keys(theme).sort()).toEqual([...ADE_CHAT_TOKENS].sort());
    for (const token of ADE_CHAT_TOKENS) {
      expect(theme[token], token).toBeTruthy();
    }
  });

  it("passes explicit inputs through untouched", () => {
    const theme = createTheme({ accent: "#ff0000", background: "#123456", fontFamily: "Inter" });
    expect(theme["--adechat-accent"]).toBe("#ff0000");
    expect(theme["--adechat-bg"]).toBe("#123456");
    expect(theme["--adechat-font"]).toBe("Inter");
  });

  it("derives a translucent accent tint from the accent", () => {
    expect(createTheme({ accent: "#ff0000" })["--adechat-accent-subtle"]).toBe("rgba(255, 0, 0, 0.14)");
  });

  it("infers the scheme from the background luminance", () => {
    const light = createTheme({ background: "#ffffff" });
    const dark = createTheme({ background: "#000000" });
    // On a light theme the foreground is dark, and vice versa.
    expect(light["--adechat-fg"]).toBe("#16181d");
    expect(dark["--adechat-fg"]).toBe("#f5f6f8");
  });

  it("moves derived surfaces away from the background in both schemes", () => {
    expect(createTheme({ background: "#000000" })["--adechat-bg-raised"]).toBe("rgb(20, 20, 20)");
    expect(createTheme({ background: "#ffffff" })["--adechat-bg-raised"]).toBe("rgb(235, 235, 235)");
  });

  it("honours an explicit scheme over the inferred one", () => {
    const theme = createTheme({ background: "#ffffff", scheme: "dark" });
    expect(theme["--adechat-bg-raised"]).toBe("rgb(255, 255, 255)");
  });

  it("picks a readable accent foreground", () => {
    expect(createTheme({ accent: "#ffff00" })["--adechat-accent-fg"]).toBe("#16181d");
    expect(createTheme({ accent: "#001133" })["--adechat-accent-fg"]).toBe("#f5f6f8");
  });

  it("expands 3- and 4-digit hex", () => {
    expect(createTheme({ accent: "#f00" })["--adechat-accent-subtle"]).toBe("rgba(255, 0, 0, 0.14)");
  });

  it("multiplies through an alpha channel in 8-digit hex", () => {
    expect(createTheme({ accent: "#ff000080" })["--adechat-accent-subtle"]).toBe("rgba(255, 0, 0, 0.07)");
  });

  it("passes non-hex colors straight through instead of guessing tints", () => {
    const theme = createTheme({ accent: "var(--brand)" });
    expect(theme["--adechat-accent"]).toBe("var(--brand)");
    expect(theme["--adechat-accent-subtle"]).toBe("var(--brand)");
  });

  it("treats numeric radius/size/space as pixels and derives a small radius", () => {
    const theme = createTheme({ radius: 20, fontSize: 16, space: 10 });
    expect(theme["--adechat-radius"]).toBe("20px");
    expect(theme["--adechat-radius-sm"]).toBe("12px");
    expect(theme["--adechat-font-size"]).toBe("16px");
    expect(theme["--adechat-space"]).toBe("10px");
  });

  it("keeps a string radius as authored and derives with calc()", () => {
    const theme = createTheme({ radius: "1rem" });
    expect(theme["--adechat-radius"]).toBe("1rem");
    expect(theme["--adechat-radius-sm"]).toBe("calc(1rem * 0.6)");
  });
});

describe("themeToCss", () => {
  it("emits every token under the given selector", () => {
    const css = themeToCss(defaultTheme, ".host");
    expect(css.startsWith(".host {")).toBe(true);
    for (const token of ADE_CHAT_TOKENS) {
      expect(css).toContain(`${token}: `);
    }
  });
});
