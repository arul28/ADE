import {
  PLUGIN_WEBVIEW_THEME_MAX_TOKENS,
  PLUGIN_WEBVIEW_THEME_TOKEN_MAX_CHARS,
  type PluginWebviewThemeSnapshot,
} from "../../../../shared/plugins/webviewBridge";

/**
 * ADE's palette, as a plugin page is allowed to see it.
 *
 * A page cannot read the host's stylesheet — different origin, different
 * process — so matching ADE means being HANDED the tokens. This reads them off
 * the live document and hands over exactly two families:
 *
 * - `--ade-*`, the plugin-facing names, verbatim. They exist for this.
 * - `--color-*`, ADE's own palette, renamed to `--ade-*`. The app's real colours
 *   live under this prefix, and a page given only `--ade-*` would be given
 *   almost nothing. Renaming rather than passing both through is what keeps the
 *   plugin contract ONE namespace: a page writes `var(--ade-accent)` and never
 *   has to know which of ADE's two prefixes a colour happened to be defined in.
 *
 * A name defined under both wins as `--ade-*`: an explicit plugin-facing token
 * is a deliberate statement about what plugins see, and the palette entry it
 * shadows is the default it was written to override.
 *
 * ## Why the values are read rather than the declarations
 *
 * `getComputedStyle` resolves the cascade — the `[data-theme]` block that is
 * actually in force, the light/dark media query, a `theme` plugin's own
 * overrides. Reading the raw stylesheet would hand a page the palette of
 * whichever block happened to be written last.
 */

/** The two prefixes read, and the one every token is published under. */
export const PLUGIN_WEBVIEW_TOKEN_PREFIX = "--ade-";
const PALETTE_PREFIX = "--color-";

/**
 * Every custom property in force on an element, as `[name, value]`.
 *
 * `CSSStyleDeclaration` is index-addressable and a computed style enumerates
 * custom properties in Chromium, which is the only engine this renderer runs
 * in. Guarded anyway: a test environment's stub may enumerate nothing, and the
 * honest answer there is an empty palette rather than a throw at mount.
 */
function readCustomProperties(style: CSSStyleDeclaration): [string, string][] {
  const found: [string, string][] = [];
  const length = typeof style.length === "number" ? style.length : 0;
  for (let index = 0; index < length; index += 1) {
    const name = style.item(index);
    if (!name || !name.startsWith("--")) continue;
    const value = style.getPropertyValue(name).trim();
    if (!value) continue;
    found.push([name, value]);
  }
  return found;
}

/**
 * The snapshot to publish for the theme currently on screen.
 *
 * `scheme` is passed in rather than sniffed: the app already holds it as state,
 * and re-deriving it from the DOM would give the host two answers to a question
 * with one.
 */
export function readPluginWebviewTheme(
  scheme: "dark" | "light",
  root: Element | null = typeof document === "undefined" ? null : document.documentElement,
): PluginWebviewThemeSnapshot {
  const tokens: Record<string, string> = {};
  if (!root || typeof window === "undefined" || typeof window.getComputedStyle !== "function") {
    return { scheme, tokens };
  }
  const style = window.getComputedStyle(root);
  const palette: Record<string, string> = {};
  const plugin: Record<string, string> = {};
  for (const [name, value] of readCustomProperties(style)) {
    if (value.length > PLUGIN_WEBVIEW_THEME_TOKEN_MAX_CHARS) continue;
    if (name.startsWith(PLUGIN_WEBVIEW_TOKEN_PREFIX)) {
      plugin[name] = value;
      continue;
    }
    if (name.startsWith(PALETTE_PREFIX)) {
      palette[`${PLUGIN_WEBVIEW_TOKEN_PREFIX}${name.slice(PALETTE_PREFIX.length)}`] = value;
    }
  }
  // Palette first, plugin names second, so an explicit `--ade-*` overrides the
  // renamed palette entry it shadows.
  for (const [name, value] of [...Object.entries(palette), ...Object.entries(plugin)]) {
    if (Object.keys(tokens).length >= PLUGIN_WEBVIEW_THEME_MAX_TOKENS) break;
    tokens[name] = value;
  }
  return { scheme, tokens };
}

/** Whether two snapshots say the same thing, so an equal republish is skipped. */
export function pluginWebviewThemeEqual(
  a: PluginWebviewThemeSnapshot | null,
  b: PluginWebviewThemeSnapshot,
): boolean {
  if (!a || a.scheme !== b.scheme) return false;
  const aKeys = Object.keys(a.tokens);
  if (aKeys.length !== Object.keys(b.tokens).length) return false;
  return aKeys.every((key) => a.tokens[key] === b.tokens[key]);
}
