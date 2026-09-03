/**
 * The two palettes the kit ships, and the one function a plugin page calls to
 * put them on the document.
 *
 * Values are ported verbatim from the desktop app's `index.css` — the `:root` /
 * `[data-theme="dark"]` block and the `[data-theme="light"]` block — with the
 * variable names mapped `--color-*` → `--ade-*`. A plugin page therefore draws
 * in the same colours as the app around it without shipping the app's
 * stylesheet.
 *
 * A page normally does not pick a palette itself: it calls
 * `applyAdeTheme(scheme, tokens)` with what `window.adePlugin.theme.get()`
 * returned, so it follows the host. The built-in palettes are the fallback for
 * a page rendered before the bridge answers, and the baseline the host's own
 * token map is merged onto.
 */

import { ADE_TOKENS, type AdeColorScheme, type AdeTheme, type AdeToken } from "../tokens";

const SANS_STACK =
  "\"Geist\", system-ui, -apple-system, BlinkMacSystemFont, \"Segoe UI\", sans-serif";
const MONO_STACK = "\"JetBrains Mono\", \"Geist Mono\", ui-monospace, monospace";

/** ADE dark — `:root` / `[data-theme="dark"]` in the desktop stylesheet. */
export const darkTheme: AdeTheme = {
  "--ade-bg": "#0C0B10",
  "--ade-fg": "#F0F0F2",
  "--ade-surface": "#16141E",
  "--ade-card": "#1A1830",
  "--ade-card-fg": "#F0F0F2",
  "--ade-card-solid": "#181423",
  "--ade-muted": "#1E1B28",
  "--ade-muted-fg": "#908FA0",
  "--ade-secondary-fg": "#A8A8B4",
  "--ade-border": "#302C42",
  "--ade-accent": "#A78BFA",
  "--ade-accent-fg": "#0C0B10",
  "--ade-accent-muted": "rgba(167, 139, 250, 0.20)",
  "--ade-success": "#22c55e",
  "--ade-warning": "#f59e0b",
  "--ade-error": "#ef4444",
  "--ade-info": "#3b82f6",
  "--ade-check-pass": "color-mix(in srgb, #22c55e 60%, #908FA0)",
  "--ade-pr-surface": "rgb(15, 16, 16)",
  "--ade-pr-thread-card": "rgb(23, 23, 24)",
  "--ade-pr-panel-card": "rgb(24, 23, 43)",
  "--ade-shadow-panel": "0 2px 12px -2px rgba(0, 0, 0, 0.6)",
  "--ade-font-sans": SANS_STACK,
  "--ade-font-mono": MONO_STACK,
};

/** ADE light — `[data-theme="light"]` in the desktop stylesheet. */
export const lightTheme: AdeTheme = {
  "--ade-bg": "#f5f3f0",
  "--ade-fg": "#1a1a1e",
  "--ade-surface": "#faf8f5",
  "--ade-card": "#ffffff",
  "--ade-card-fg": "#1a1a1e",
  // The light theme deliberately reuses the dark solid-card colour; ported as
  // it stands in `index.css` rather than "corrected" here.
  "--ade-card-solid": "#181423",
  "--ade-muted": "#ece9e4",
  "--ade-muted-fg": "#636370",
  "--ade-secondary-fg": "#52525b",
  "--ade-border": "#d6d3ce",
  "--ade-accent": "#049068",
  "--ade-accent-fg": "#ffffff",
  "--ade-accent-muted": "rgba(4, 144, 104, 0.10)",
  "--ade-success": "#16a34a",
  "--ade-warning": "#d97706",
  "--ade-error": "#dc2626",
  "--ade-info": "#2563eb",
  "--ade-check-pass": "color-mix(in srgb, #16a34a 60%, #636370)",
  "--ade-pr-surface": "#f5f3f0",
  "--ade-pr-thread-card": "#ffffff",
  "--ade-pr-panel-card": "color-mix(in srgb, #049068 6%, #ffffff)",
  "--ade-shadow-panel": "0 4px 16px -4px rgba(0, 0, 0, 0.08), 0 1px 3px -1px rgba(0, 0, 0, 0.05)",
  "--ade-font-sans": SANS_STACK,
  "--ade-font-mono": MONO_STACK,
};

export function themeForScheme(scheme: AdeColorScheme): AdeTheme {
  return scheme === "light" ? lightTheme : darkTheme;
}

const TOKEN_SET = new Set<string>(ADE_TOKENS);

/**
 * Merge a host-supplied token map onto a scheme's palette.
 *
 * The host is the authority on its own colours, but it is also untrusted
 * input arriving over `postMessage`: keys the kit does not know are dropped,
 * and non-string values are ignored, so a malformed answer degrades to the
 * built-in palette instead of writing junk onto `:root`.
 */
export function createTheme(
  scheme: AdeColorScheme = "dark",
  overrides?: Readonly<Record<string, unknown>> | null,
): AdeTheme {
  const base = { ...themeForScheme(scheme) };
  if (!overrides) return base;
  for (const [key, value] of Object.entries(overrides)) {
    const token = key.startsWith("--") ? key : `--ade-${key}`;
    if (!TOKEN_SET.has(token)) continue;
    if (typeof value !== "string" || !value.trim()) continue;
    base[token as AdeToken] = value;
  }
  return base;
}

/** Serialize a theme for a `<style>` block or a stylesheet string. */
export function themeToCss(theme: AdeTheme, selector = ":root"): string {
  const body = ADE_TOKENS.map((token) => `  ${token}: ${theme[token]};`).join("\n");
  return `${selector} {\n${body}\n}`;
}

/**
 * Write a palette onto `:root` (or another element).
 *
 * This is what a plugin page calls with the answer from
 * `window.adePlugin.theme.get()`, and again on every `theme` event. It also
 * stamps `data-ade-theme` so a page can branch on the scheme in its own CSS.
 */
export function applyAdeTheme(
  scheme: AdeColorScheme,
  overrides?: Readonly<Record<string, unknown>> | null,
  target?: HTMLElement | null,
): AdeTheme {
  const theme = createTheme(scheme, overrides);
  const element =
    target ?? (typeof document === "undefined" ? null : document.documentElement);
  if (!element) return theme;
  for (const token of ADE_TOKENS) element.style.setProperty(token, theme[token]);
  element.setAttribute("data-ade-theme", scheme);
  element.style.colorScheme = scheme;
  return theme;
}
