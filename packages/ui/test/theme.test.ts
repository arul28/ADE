import { beforeEach, describe, expect, it } from "vitest";
import {
  ADE_STYLE_ID,
  ADE_TOKENS,
  adeCss,
  applyAdeTheme,
  createTheme,
  darkTheme,
  injectAdeStyles,
  lightTheme,
  themeForScheme,
  themeToCss,
} from "../src/index";

describe("palettes", () => {
  it("carries the desktop index.css values", () => {
    expect(darkTheme["--ade-bg"]).toBe("#0C0B10");
    expect(darkTheme["--ade-fg"]).toBe("#F0F0F2");
    expect(darkTheme["--ade-accent"]).toBe("#A78BFA");
    expect(darkTheme["--ade-border"]).toBe("#302C42");
    expect(lightTheme["--ade-bg"]).toBe("#f5f3f0");
    expect(lightTheme["--ade-fg"]).toBe("#1a1a1e");
    expect(lightTheme["--ade-accent"]).toBe("#049068");
    expect(lightTheme["--ade-border"]).toBe("#d6d3ce");
  });

  it("defines every token in both schemes", () => {
    for (const token of ADE_TOKENS) {
      expect(darkTheme[token], token).toBeTruthy();
      expect(lightTheme[token], token).toBeTruthy();
    }
    expect(themeForScheme("light")).toBe(lightTheme);
    expect(themeForScheme("dark")).toBe(darkTheme);
  });
});

describe("createTheme", () => {
  it("merges a host token map onto the scheme palette", () => {
    const theme = createTheme("dark", { "--ade-accent": "#ff0000", accent: "#00ff00" });
    // The bare key is normalised to the token, and the later key wins.
    expect(theme["--ade-accent"]).toBe("#00ff00");
    expect(theme["--ade-bg"]).toBe(darkTheme["--ade-bg"]);
  });

  it("drops keys it does not know and values that are not strings", () => {
    // The token map arrives over postMessage. Junk must not reach :root.
    const theme = createTheme("dark", {
      "--evil": "url(x)",
      "--ade-bg": 42 as unknown as string,
      "--ade-fg": "   ",
      "--ade-accent": "#123456",
    });
    expect(Object.keys(theme)).toHaveLength(ADE_TOKENS.length);
    expect(theme).not.toHaveProperty("--evil");
    expect(theme["--ade-bg"]).toBe(darkTheme["--ade-bg"]);
    expect(theme["--ade-fg"]).toBe(darkTheme["--ade-fg"]);
    expect(theme["--ade-accent"]).toBe("#123456");
  });

  it("serialises to CSS under any selector", () => {
    const css = themeToCss(lightTheme, ".x");
    expect(css.startsWith(".x {")).toBe(true);
    expect(css).toContain("--ade-accent: #049068;");
  });
});

describe("applyAdeTheme", () => {
  beforeEach(() => {
    document.documentElement.removeAttribute("style");
    document.documentElement.removeAttribute("data-ade-theme");
    document.getElementById(ADE_STYLE_ID)?.remove();
  });

  it("writes every token onto :root and stamps the scheme", () => {
    applyAdeTheme("light");
    const root = document.documentElement;
    expect(root.getAttribute("data-ade-theme")).toBe("light");
    expect(root.style.getPropertyValue("--ade-bg")).toBe("#f5f3f0");
    expect(root.style.colorScheme).toBe("light");
    for (const token of ADE_TOKENS) expect(root.style.getPropertyValue(token), token).not.toBe("");
  });

  it("re-themes in place when the host switches scheme", () => {
    applyAdeTheme("light");
    applyAdeTheme("dark", { "--ade-accent": "#abcdef" });
    expect(document.documentElement.style.getPropertyValue("--ade-bg")).toBe("#0C0B10");
    expect(document.documentElement.style.getPropertyValue("--ade-accent")).toBe("#abcdef");
  });

  it("targets an element other than :root when asked", () => {
    const host = document.createElement("div");
    applyAdeTheme("dark", null, host);
    expect(host.style.getPropertyValue("--ade-fg")).toBe("#F0F0F2");
    expect(document.documentElement.style.getPropertyValue("--ade-fg")).toBe("");
  });
});

describe("injectAdeStyles", () => {
  beforeEach(() => document.getElementById(ADE_STYLE_ID)?.remove());

  it("adds the sheet once", () => {
    injectAdeStyles();
    injectAdeStyles();
    expect(document.querySelectorAll(`#${ADE_STYLE_ID}`)).toHaveLength(1);
    expect(document.getElementById(ADE_STYLE_ID)?.textContent).toContain(".ade-btn");
  });

  it("ships a stylesheet with no external reference", () => {
    // The guest's content policy blocks every remote fetch, silently. A single
    // @import or url(https://…) in this string is an invisible failure.
    expect(adeCss).not.toMatch(/@import/);
    expect(adeCss).not.toMatch(/url\(\s*['"]?https?:/);
    expect(adeCss).toContain(":root {");
    expect(adeCss).toContain('[data-ade-theme="light"]');
    expect(adeCss).toContain("prefers-color-scheme: light");
  });
});
