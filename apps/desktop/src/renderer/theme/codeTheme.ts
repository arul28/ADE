/**
 * The active theme, expressed for the two code surfaces that have their own
 * colour engines: Monaco (the file editor) and Shiki (code blocks in chat).
 *
 * Both are fed from the theme's resolved palette and syntax colours, so a theme
 * paints its editor and its code blocks the way it paints everything else. The
 * stylesheet themes `dark` and `light` are the exception: they keep the
 * editor and code colours ADE has always shipped, and `usesStockCodeColors`
 * tells the callers to leave them alone.
 */

import type * as Monaco from "monaco-editor";
import {
  MONACO_SYNTAX_TOKENS,
  STYLESHEET_THEME_IDS,
  SYNTAX_SCOPES,
  parseColor,
  toHex,
  type AdeSyntaxKey,
  type ResolvedAdeTheme,
} from "../../shared/theme";

/** True for the two themes whose code colours stay as the stylesheet era shipped them. */
export function usesStockCodeColors(resolved: ResolvedAdeTheme): boolean {
  return resolved.theme.source === "builtin" && STYLESHEET_THEME_IDS.includes(resolved.theme.id);
}

function hex(color: string, fallback = "#000000"): string {
  const parsed = parseColor(color);
  return parsed ? toHex(parsed) : fallback;
}

/** `#rrggbbaa`, which Monaco accepts for translucent editor colours. */
function hexAlpha(color: string, alpha: number): string {
  const base = hex(color);
  const channel = Math.round(Math.max(0, Math.min(1, alpha)) * 255).toString(16).padStart(2, "0");
  return `${base}${channel}`;
}

const SYNTAX_KEYS = Object.keys(MONACO_SYNTAX_TOKENS) as AdeSyntaxKey[];

/** A Monaco theme from a resolved ADE theme: surfaces from the palette, tokens from the syntax colours. */
export function monacoThemeData(resolved: ResolvedAdeTheme): Monaco.editor.IStandaloneThemeData {
  const { palette: p, syntax } = resolved;
  const surface = hex(p.surface);
  const surfaces = {
    "editor.background": surface,
    "editorGutter.background": surface,
    "editorStickyScroll.background": surface,
    "editorStickyScrollHover.background": hex(p.surfaceRaised),
    "minimap.background": surface,
    "editorOverviewRuler.background": surface,
  };
  const rules: Monaco.editor.ITokenThemeRule[] = [];
  for (const key of SYNTAX_KEYS) {
    const foreground = hex(syntax[key]).slice(1);
    for (const token of MONACO_SYNTAX_TOKENS[key]) {
      rules.push({ token, foreground, ...(key === "comment" ? { fontStyle: "italic" } : {}) });
    }
  }
  return {
    base: resolved.theme.baseMode === "light" ? "vs" : "vs-dark",
    inherit: true,
    rules,
    colors: {
      ...surfaces,
      "editor.foreground": hex(p.fg),
      "editorCursor.foreground": hex(p.accent),
      "editor.lineHighlightBackground": hexAlpha(p.fg, 0.05),
      "editor.selectionBackground": hexAlpha(p.accent, 0.28),
      "editor.inactiveSelectionBackground": hexAlpha(p.accent, 0.16),
      "editor.findMatchBackground": hexAlpha(p.warning, 0.4),
      "editor.findMatchHighlightBackground": hexAlpha(p.warning, 0.22),
      "editorLineNumber.foreground": hexAlpha(p.mutedFg, 0.75),
      "editorLineNumber.activeForeground": hex(p.fg),
      "editorIndentGuide.background1": hexAlpha(p.fg, 0.08),
      "editorIndentGuide.activeBackground1": hexAlpha(p.fg, 0.2),
      "editorWhitespace.foreground": hexAlpha(p.fg, 0.14),
      "editorWidget.background": hex(p.popover),
      "editorWidget.border": hex(p.border),
      "editorSuggestWidget.background": hex(p.popover),
      "editorSuggestWidget.border": hex(p.border),
      "editorSuggestWidget.selectedBackground": hexAlpha(p.accent, 0.2),
      "editorHoverWidget.background": hex(p.popover),
      "editorHoverWidget.border": hex(p.border),
      "scrollbarSlider.background": hexAlpha(p.fg, 0.12),
      "scrollbarSlider.hoverBackground": hexAlpha(p.fg, 0.2),
      "scrollbarSlider.activeBackground": hexAlpha(p.fg, 0.28),
      "diffEditor.insertedTextBackground": hexAlpha(p.diffAdd, 0.2),
      "diffEditor.removedTextBackground": hexAlpha(p.diffDel, 0.2),
    },
  };
}

/** The Monaco theme name for a resolved theme. Keyed by id so two themes never share a definition. */
export function monacoThemeName(resolved: ResolvedAdeTheme): string {
  return `ade-theme-${resolved.theme.id}`;
}

/**
 * Define the theme in Monaco and return its name, or return `stockName` for a
 * theme that keeps the stock editor colours. Monaco themes are global, so the
 * definition is replaced on every call: editing a custom theme repaints.
 */
export function applyMonacoTheme(monaco: typeof Monaco, resolved: ResolvedAdeTheme, stockName: string): string {
  if (usesStockCodeColors(resolved)) return stockName;
  const name = monacoThemeName(resolved);
  monaco.editor.defineTheme(name, monacoThemeData(resolved));
  return name;
}

/** The shape Shiki's `loadTheme` accepts, limited to what ADE sets. */
export type ShikiThemeData = {
  name: string;
  type: "dark" | "light";
  colors: Record<string, string>;
  tokenColors: { scope: string[]; settings: { foreground: string; fontStyle?: string } }[];
};

/**
 * A Shiki theme from a resolved ADE theme, written through the same scope table
 * the VS Code importer reads, so an imported theme's code colours round-trip.
 */
export function shikiThemeData(resolved: ResolvedAdeTheme): ShikiThemeData {
  const { palette: p, syntax } = resolved;
  const tokenColors: ShikiThemeData["tokenColors"] = SYNTAX_KEYS.map((key) => ({
    scope: [...SYNTAX_SCOPES[key].scopes],
    settings: {
      foreground: hex(syntax[key]),
      ...(key === "comment" ? { fontStyle: "italic" } : {}),
    },
  }));
  return {
    name: `ade-theme-${resolved.theme.id}`,
    type: resolved.theme.baseMode,
    colors: {
      "editor.background": hex(p.surfaceRecessed),
      "editor.foreground": hex(p.fg),
    },
    tokenColors,
  };
}
