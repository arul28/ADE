/**
 * The plugin theme engine.
 *
 * A theme plugin ships no code — only token sets, one per built-in theme it
 * extends. This module turns those tokens into exactly one `<style>` block and
 * owns its whole lifecycle: preview, revert, apply, clear.
 *
 * Three decisions are load-bearing and should not be "simplified" away:
 *
 * 1. **A stylesheet, never `documentElement.style.setProperty`.** ADE re-declares
 *    its palette on `<body>` as well as `:root` (see `index.css`), so an inline
 *    custom property set on the document element is shadowed for every element
 *    inside `<body>` — the same trap `lib/zoom.ts` documents. Injecting a rule
 *    that matches the same `[data-theme]` elements the app's own palette matches
 *    is the only application that actually reaches the whole tree.
 * 2. **Tokens are allowlisted by prefix AND value-sanitized.** A plugin's tokens
 *    are untrusted text that ends up inside a stylesheet. A value containing
 *    `}` would close the rule and let a theme inject arbitrary CSS — including
 *    rules that hide ADE's own chrome. {@link sanitizePluginThemeTokens} rejects
 *    anything that is not a plain colour-ish value.
 * 3. **Preview does not persist.** Previewing is how a theme is evaluated, so it
 *    must be free to abandon: {@link previewPluginTheme} paints, and
 *    {@link revertPluginThemePreview} returns to whatever was actually applied.
 *    Only {@link applyPluginTheme} changes what a restart would restore, and the
 *    persistence itself lives in the root app store, not here.
 *
 * Surfaces that read colours through JavaScript rather than CSS — xterm, the
 * activity heatmap, provider colours, the Windows caption strip — cannot observe
 * a stylesheet swap on their own. They are notified through
 * {@link PLUGIN_THEME_CHANGED_EVENT}.
 */

import { isAllowedPluginThemeToken, PLUGIN_THEME_TOKEN_PREFIXES } from "../../shared/plugins/manifest";
import type { PluginClientThemeTokens } from "../../shared/plugins/sdk";

export { PLUGIN_THEME_TOKEN_PREFIXES };

export const PLUGIN_THEME_STYLE_ELEMENT_ID = "ade-plugin-theme";

/**
 * Fired on `window` after the injected stylesheet changes. Consumers that read
 * theme values in JavaScript re-read on this; consumers that read them through
 * CSS need nothing.
 */
export const PLUGIN_THEME_CHANGED_EVENT = "ade:plugin-theme-changed";

/** The built-in themes a plugin theme can extend. Mirrors `ThemeId`. */
export type PluginThemeBaseId = "dark" | "light";

/**
 * Alias of the wire type in `shared/plugins/sdk.ts`. One declaration: the
 * preload publishes these tokens, the engine paints them, and a second
 * structural copy is how the two would drift without anything failing.
 */
export type PluginThemeTokens = PluginClientThemeTokens;

export type PluginThemeDefinition = {
  pluginId: string;
  /** Shown beside the built-in themes in Appearance. */
  displayName: string;
  tokens: PluginThemeTokens;
};

/** Per-theme ceiling. A palette is dozens of tokens; hundreds is not a palette. */
export const PLUGIN_THEME_MAX_TOKENS = 120;

/** Longest accepted value. Comfortably fits a multi-stop gradient. */
export const PLUGIN_THEME_MAX_VALUE_CHARS = 240;

/**
 * Characters a token value may contain.
 *
 * Everything needed to write a colour, a `color-mix`, a gradient or a shadow —
 * and nothing that can terminate a declaration (`;`), close a block (`}`), open
 * an at-rule (`@`), start a comment (`/*`), or leave CSS entirely (`<`).
 */
const SAFE_VALUE_PATTERN = /^[a-zA-Z0-9#%.,()\-+_/ ]+$/;

/**
 * Functions that can fetch or execute rather than just describe a colour.
 * `var(--…)` is deliberately NOT here: referencing another palette token is the
 * normal way to write a derived theme.
 */
const FORBIDDEN_VALUE_TOKENS = ["url(", "image-set(", "expression(", "//", "/*"];

export type SanitizedPluginTheme = {
  tokens: PluginThemeTokens;
  /** `"<base>.<token>"` for every entry that was dropped, with the reason. */
  rejected: { token: string; reason: string }[];
};

/**
 * The name half of the allowlist lives in the manifest parser so a theme is
 * judged identically at parse time and at paint time. Both halves matter: the
 * name is interpolated on the left of the colon, so a name that is merely
 * prefix-correct can still close the rule and inject CSS.
 */
const isAllowedTokenName = isAllowedPluginThemeToken;

function isSafeTokenValue(value: string): boolean {
  if (value.length === 0 || value.length > PLUGIN_THEME_MAX_VALUE_CHARS) return false;
  if (!SAFE_VALUE_PATTERN.test(value)) return false;
  const lowered = value.toLowerCase();
  if (FORBIDDEN_VALUE_TOKENS.some((token) => lowered.includes(token))) return false;
  // Unbalanced parens would let a value swallow the rest of the rule.
  let depth = 0;
  for (const character of value) {
    if (character === "(") depth += 1;
    else if (character === ")") depth -= 1;
    if (depth < 0) return false;
  }
  return depth === 0;
}

/**
 * Drop every token a theme may not set, and every value that is not plainly a
 * colour. Returns what survived plus what was rejected, so the marketplace can
 * tell an author their theme was partially ignored instead of silently
 * swallowing half of it.
 */
export function sanitizePluginThemeTokens(tokens: PluginThemeTokens | null | undefined): SanitizedPluginTheme {
  const rejected: { token: string; reason: string }[] = [];
  const clean: PluginThemeTokens = {};
  if (!tokens || typeof tokens !== "object") return { tokens: clean, rejected };

  for (const base of ["dark", "light"] as const) {
    const source = tokens[base];
    if (!source || typeof source !== "object") continue;
    const collected: Record<string, string> = {};
    let count = 0;
    for (const [rawName, rawValue] of Object.entries(source)) {
      const name = typeof rawName === "string" ? rawName.trim() : "";
      const value = typeof rawValue === "string" ? rawValue.trim() : "";
      const label = `${base}.${name || "(unnamed)"}`;
      if (!isAllowedTokenName(name)) {
        rejected.push({ token: label, reason: "not an ADE palette token" });
        continue;
      }
      if (!isSafeTokenValue(value)) {
        rejected.push({ token: label, reason: "value is not a plain colour" });
        continue;
      }
      if (count >= PLUGIN_THEME_MAX_TOKENS) {
        rejected.push({ token: label, reason: `over the ${PLUGIN_THEME_MAX_TOKENS}-token limit` });
        continue;
      }
      collected[name] = value;
      count += 1;
    }
    if (count > 0) clean[base] = collected;
  }

  return { tokens: clean, rejected };
}

/**
 * The stylesheet text for a sanitized token set, or `""` when there is nothing
 * to say.
 *
 * The selector repeats the attribute (`[data-theme="dark"][data-theme]`) to sit
 * one specificity step above `index.css`'s own `[data-theme="dark"]` block. That
 * makes the override independent of stylesheet order, which in a Vite dev server
 * is not something a renderer can rely on.
 */
export function buildPluginThemeCss(tokens: PluginThemeTokens): string {
  const blocks: string[] = [];
  for (const base of ["dark", "light"] as const) {
    const entries = Object.entries(tokens[base] ?? {});
    if (entries.length === 0) continue;
    const declarations = entries.map(([name, value]) => `  ${name}: ${value};`).join("\n");
    blocks.push(`[data-theme="${base}"][data-theme] {\n${declarations}\n}`);
  }
  return blocks.join("\n\n");
}

/* ── Live application ───────────────────────────────────────────────────── */

type EngineState = {
  /** What a restart would restore. */
  applied: PluginThemeDefinition | null;
  /** What is painted right now, if it differs from `applied`. */
  preview: PluginThemeDefinition | null;
};

const state: EngineState = { applied: null, preview: null };

function styleElement(create: boolean): HTMLStyleElement | null {
  if (typeof document === "undefined") return null;
  const existing = document.getElementById(PLUGIN_THEME_STYLE_ELEMENT_ID);
  if (existing instanceof HTMLStyleElement) return existing;
  if (!create) return null;
  const element = document.createElement("style");
  element.id = PLUGIN_THEME_STYLE_ELEMENT_ID;
  // Last in `<head>` so the rule participates normally in the cascade rather
  // than racing whatever the bundler injected.
  document.head.appendChild(element);
  return element;
}

function paint(definition: PluginThemeDefinition | null): void {
  const css = definition ? buildPluginThemeCss(sanitizePluginThemeTokens(definition.tokens).tokens) : "";
  const existing = styleElement(false);
  const currentCss = existing?.textContent ?? "";
  const currentPluginId = existing?.dataset.pluginId ?? null;
  const nextPluginId = css ? (definition?.pluginId ?? null) : null;

  // The registry hands back a fresh array on every refresh, so the caller's
  // effect re-runs far more often than the theme actually changes. Repainting
  // would be cheap, but the change event is not: it tells xterm and the heatmap
  // to re-read their colours, and doing that on every poll is real churn.
  if (currentCss === css && currentPluginId === nextPluginId) return;

  if (!css) {
    existing?.remove();
  } else {
    const element = styleElement(true);
    if (element) {
      element.textContent = css;
      element.dataset.pluginId = definition?.pluginId ?? "";
    }
  }
  if (typeof window !== "undefined") {
    window.dispatchEvent(
      new CustomEvent(PLUGIN_THEME_CHANGED_EVENT, { detail: { pluginId: nextPluginId } }),
    );
  }
}

/**
 * Paint a theme without changing what is applied. Calling it again replaces the
 * previous preview; {@link revertPluginThemePreview} undoes all of it.
 */
export function previewPluginTheme(definition: PluginThemeDefinition): void {
  state.preview = definition;
  paint(definition);
}

/** Return to the applied theme (or none). Safe to call with no preview running. */
export function revertPluginThemePreview(): void {
  if (!state.preview) return;
  state.preview = null;
  paint(state.applied);
}

/**
 * Make a theme the applied one, ending any preview. Pass `null` to return to the
 * built-in palette. Persisting the choice is the caller's job — the root app
 * store owns that so it rides the same prefs blob as every other appearance
 * setting.
 */
export function applyPluginTheme(definition: PluginThemeDefinition | null): void {
  state.applied = definition;
  state.preview = null;
  paint(definition);
}

/** The theme a restart would restore, ignoring any running preview. */
export function appliedPluginTheme(): PluginThemeDefinition | null {
  return state.applied;
}

/** True while a preview is painted over the applied theme. */
export function isPreviewingPluginTheme(): boolean {
  return state.preview !== null;
}

/** The stylesheet text currently painted, or null when the built-ins are in effect. */
export function currentPluginThemeCss(): string | null {
  const element = styleElement(false);
  const css = element?.textContent ?? "";
  return css.length > 0 ? css : null;
}

/** Test seam: drop the injected stylesheet and forget both slots. */
export function resetPluginThemeEngine(): void {
  state.applied = null;
  state.preview = null;
  styleElement(false)?.remove();
}
