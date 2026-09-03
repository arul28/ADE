/* @vitest-environment jsdom */

import { describe, expect, it } from "vitest";

import { sanitizePluginWebviewTheme } from "../../../../shared/plugins/webviewBridge";
import { pluginWebviewThemeEqual, readPluginWebviewTheme } from "./pluginWebviewTheme";

/**
 * What a plugin page is handed about ADE's palette, and under which names.
 *
 * The rule that matters is the RENAME. ADE's real colours live under
 * `--color-*` and a page given only `--ade-*` would be given almost nothing, so
 * the palette crosses renamed into the one namespace the plugin contract names.
 * A page writes `var(--ade-accent)` and never learns that the host has two
 * prefixes.
 */

/** Put a stylesheet on the document and hand back the root it applies to. */
function withTokens(css: string): Element {
  const style = document.createElement("style");
  style.textContent = `:root { ${css} }`;
  document.head.replaceChildren(style);
  return document.documentElement;
}

describe("readPluginWebviewTheme", () => {
  it("renames the app palette into the plugin namespace", () => {
    const root = withTokens("--color-accent: #7c3aed; --color-bg: #101014;");
    const snapshot = readPluginWebviewTheme("dark", root);
    expect(snapshot.scheme).toBe("dark");
    expect(snapshot.tokens["--ade-accent"]).toBe("#7c3aed");
    expect(snapshot.tokens["--ade-bg"]).toBe("#101014");
    // The host's own prefix never crosses: a page that learned to read
    // `--color-*` would be reading a name the contract does not promise.
    expect(Object.keys(snapshot.tokens).every((name) => name.startsWith("--ade-"))).toBe(true);
  });

  it("lets an explicit plugin-facing token win over the palette entry it shadows", () => {
    const root = withTokens("--color-accent: #7c3aed; --ade-accent: #ff0000;");
    expect(readPluginWebviewTheme("light", root).tokens["--ade-accent"]).toBe("#ff0000");
  });

  it("publishes nothing outside the two prefixes", () => {
    const root = withTokens("--shell-header-padding-end: 12px; --color-fg: #fff;");
    const snapshot = readPluginWebviewTheme("dark", root);
    expect(snapshot.tokens["--shell-header-padding-end"]).toBeUndefined();
    expect(snapshot.tokens["--ade-fg"]).toBe("#fff");
  });

  it("survives a document with no computed custom properties", () => {
    expect(readPluginWebviewTheme("dark", null)).toEqual({ scheme: "dark", tokens: {} });
  });

  it("produces a snapshot the host's own sanitizer accepts unchanged", () => {
    const root = withTokens("--color-accent: #7c3aed;");
    const snapshot = readPluginWebviewTheme("dark", root);
    expect(sanitizePluginWebviewTheme(snapshot)).toEqual(snapshot);
  });
});

describe("pluginWebviewThemeEqual", () => {
  it("skips a republish only when nothing moved", () => {
    const a = { scheme: "dark" as const, tokens: { "--ade-accent": "#111" } };
    expect(pluginWebviewThemeEqual(a, { ...a })).toBe(true);
    expect(pluginWebviewThemeEqual(a, { scheme: "light", tokens: a.tokens })).toBe(false);
    expect(pluginWebviewThemeEqual(a, { scheme: "dark", tokens: { "--ade-accent": "#222" } })).toBe(false);
    expect(pluginWebviewThemeEqual(a, { scheme: "dark", tokens: {} })).toBe(false);
    expect(pluginWebviewThemeEqual(null, a)).toBe(false);
  });
});
