/**
 * ADE's palette, as a snapshot a plugin page can paint itself with.
 *
 * A page runs on an opaque origin with none of the app's stylesheets, so
 * "match ADE" cannot mean "inherit from the host". It means the host hands over
 * the resolved custom properties and the page writes them onto its own `:root`.
 * That is what `theme.get` and the `theme` event carry.
 *
 * The names come from `PLUGIN_THEME_TOKEN_PREFIXES` — the same namespaces a
 * plugin THEME may set — rather than from a hand-kept list. One allowlist for
 * both directions means a token a plugin can override is exactly a token a
 * plugin page can read, and neither drifts from the other.
 *
 * The values are read off the live document rather than a table, so an applied
 * plugin theme, a future palette change and the reader's own light/dark choice
 * all reach a page without this file learning about any of them.
 */

import {
  PLUGIN_THEME_TOKEN_NAME_PATTERN,
  PLUGIN_THEME_TOKEN_PREFIXES,
} from "../../../shared/plugins/manifest";
import {
  PLUGIN_WEBVIEW_THEME_MAX_TOKENS,
  type PluginWebviewThemeSnapshot,
} from "../../../shared/plugins/webviewBridge";

/**
 * One declared property name, whichever way the CSSOM exposes it.
 *
 * `item(index)` is the spec's accessor and what a browser answers with; some
 * implementations only expose the indexed properties. Reading both is cheaper
 * than a browser check, and the alternative is a theme that silently comes back
 * empty on the implementation that lacks one.
 */
function readDeclarationName(style: CSSStyleDeclaration, index: number): string | null {
  const named = typeof style.item === "function" ? style.item(index) : undefined;
  const value = named ?? (style as unknown as Record<number, unknown>)[index];
  return typeof value === "string" ? value : null;
}

let cachedNames: { sheets: number; names: string[] } | null = null;

/**
 * Every palette token name the document's own stylesheets declare.
 *
 * Custom properties are not enumerable on a `CSSStyleDeclaration` in every
 * browser, so the NAMES are collected from the rules and the VALUES are read
 * from the computed style — which is the only place the cascade, the reader's
 * theme and any applied plugin theme have already been resolved into one
 * answer.
 *
 * A stylesheet this document may not read (a cross-origin one) is skipped
 * rather than fatal: it contributes no palette tokens by construction, since
 * every one ADE defines ships in its own bundle.
 */
function paletteTokenNames(document: Document): string[] {
  // Memoized on the stylesheet count, because `theme.get` is a verb an
  // untrusted page may call as often as it likes and this walks every rule in
  // the client's own stylesheet. The NAMES only move when a stylesheet is added
  // or removed; the values are read fresh from the computed style every time,
  // which is what makes a theme change and an applied plugin theme both land.
  if (cachedNames && cachedNames.sheets === document.styleSheets.length) return cachedNames.names;
  const names = new Set<string>();
  for (const sheet of Array.from(document.styleSheets)) {
    let rules: CSSRuleList;
    try {
      rules = sheet.cssRules;
    } catch {
      continue;
    }
    for (const rule of Array.from(rules)) {
      const style = (rule as CSSStyleRule).style as CSSStyleDeclaration | undefined;
      if (!style) continue;
      for (let index = 0; index < style.length; index += 1) {
        const name = readDeclarationName(style, index);
        if (!name || !name.startsWith("--")) continue;
        if (!PLUGIN_THEME_TOKEN_NAME_PATTERN.test(name)) continue;
        if (!PLUGIN_THEME_TOKEN_PREFIXES.some((prefix) => name.startsWith(prefix))) continue;
        names.add(name);
      }
    }
  }
  const sorted = [...names].sort();
  cachedNames = { sheets: document.styleSheets.length, names: sorted };
  return sorted;
}

/**
 * The palette as of now.
 *
 * `scheme` reads the `data-theme` attribute the app already paints with, so a
 * page and the window around it never disagree about which of the two palettes
 * they are in.
 */
export function readPluginPageTheme(document: Document, view: Window): PluginWebviewThemeSnapshot {
  const scheme = document.documentElement.getAttribute("data-theme") === "light" ? "light" : "dark";
  const computed = view.getComputedStyle(document.documentElement);
  const tokens: Record<string, string> = {};
  for (const name of paletteTokenNames(document)) {
    if (Object.keys(tokens).length >= PLUGIN_WEBVIEW_THEME_MAX_TOKENS) break;
    const value = computed.getPropertyValue(name).trim();
    if (!value) continue;
    tokens[name] = value;
  }
  return { scheme, tokens };
}
