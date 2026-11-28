/**
 * The active theme, expressed for the two code surfaces that have their own
 * colour engines: Monaco (the file editor) and Shiki (code blocks in chat).
 *
 * Both are fed from the theme's resolved palette and syntax colours, so a theme
 * paints its editor and its code blocks the way it paints everything else. The
 * stylesheet themes `dark` and `light` are the exception: they keep the
 * editor and code colours ADE has always shipped, and `usesStockCodeColors`
 * tells the callers to leave them alone. Chat code blocks are the exception
 * for stock light (`usesStockChatCodeColors`): they use the palette like any
 * light theme.
 */

import type * as Monaco from "monaco-editor";
import {
  MONACO_SYNTAX_TOKENS,
  STYLESHEET_THEME_IDS,
  SYNTAX_SCOPES,
  contrastRatio,
  mixColors,
  parseColor,
  shiftLightness,
  toHex,
  type AdeSyntaxKey,
  type ResolvedAdeTheme,
  type Rgb,
} from "../../shared/theme";

/** True for the two themes whose code colours stay as the stylesheet era shipped them. */
export function usesStockCodeColors(resolved: ResolvedAdeTheme): boolean {
  return resolved.theme.source === "builtin" && STYLESHEET_THEME_IDS.includes(resolved.theme.id);
}

/**
 * True when chat code blocks keep Shiki's stock `github-dark-dimmed`: stock
 * dark only. Its token colours vanish on stock light's pale code box, so stock
 * light builds its code theme from its palette like any other light theme.
 */
export function usesStockChatCodeColors(resolved: ResolvedAdeTheme): boolean {
  return usesStockCodeColors(resolved) && resolved.theme.baseMode === "dark";
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

/**
 * The contrast every code colour reaches on a light theme's chat code box.
 * WCAG AA asks 4.5:1 for body text; the extra margin covers a block drawn on a
 * slightly darker card.
 */
const LIGHT_CODE_MIN_CONTRAST = 4.7;
const WHITE: Rgb = { r: 255, g: 255, b: 255 };
const BLACK: Rgb = { r: 0, g: 0, b: 0 };

/** The recessed share of `--chat-code-bg-light` (foundation.css); keep the two in step. */
const LIGHT_CODE_BOX_RECESSED_SHARE = 0.55;

/** A light theme's chat code box, as `--chat-code-bg-light` mixes it. */
function chatCodeBackground(resolved: ResolvedAdeTheme): Rgb {
  const recessed = parseColor(resolved.palette.surfaceRecessed) ?? WHITE;
  const card = parseColor(resolved.palette.card) ?? recessed;
  return mixColors(recessed, card, LIGHT_CODE_BOX_RECESSED_SHARE);
}

/** Adjust perceptual lightness until text reads on the chat code box. */
function readableOn(color: string, background: Rgb): string {
  const original = parseColor(hex(color)) ?? BLACK;
  if (contrastRatio(original, background) >= LIGHT_CODE_MIN_CONTRAST) return toHex(original);

  const blackContrast = contrastRatio(BLACK, background);
  const whiteContrast = contrastRatio(WHITE, background);
  const target = Math.min(LIGHT_CODE_MIN_CONTRAST, Math.max(blackContrast, whiteContrast));
  for (let step = 1; step < 50; step += 1) {
    if (blackContrast >= target) {
      const darker = shiftLightness(original, -step * 0.02);
      if (contrastRatio(darker, background) >= target) return toHex(darker);
    }
    if (whiteContrast >= target) {
      const lighter = shiftLightness(original, step * 0.02);
      if (contrastRatio(lighter, background) >= target) return toHex(lighter);
    }
  }
  return toHex(blackContrast >= whiteContrast ? BLACK : WHITE);
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
  const codeBackground = resolved.theme.baseMode === "light" ? chatCodeBackground(resolved) : null;
  const foreground = (color: string) => (codeBackground ? readableOn(color, codeBackground) : hex(color));
  const tokenColors: ShikiThemeData["tokenColors"] = SYNTAX_KEYS.map((key) => ({
    scope: [...SYNTAX_SCOPES[key].scopes],
    settings: {
      foreground: foreground(syntax[key]),
      ...(key === "comment" ? { fontStyle: "italic" } : {}),
    },
  }));
  return {
    name: `ade-theme-${resolved.theme.id}`,
    type: resolved.theme.baseMode,
    colors: {
      "editor.background": hex(p.surfaceRecessed),
      "editor.foreground": foreground(p.fg),
    },
    tokenColors,
  };
}

/**
 * A string that changes whenever a code surface would need repainting: the
 * theme id, mode and every colour its Shiki definition is made from. The chat
 * block cache and the Shiki theme name are keyed on it, so editing a custom
 * theme in place highlights fresh instead of reading a stale cached block.
 */
export function codeThemeFingerprint(resolved: ResolvedAdeTheme): string {
  return [
    resolved.theme.id,
    resolved.theme.baseMode,
    resolved.palette.fg,
    resolved.palette.card,
    resolved.palette.surfaceRecessed,
    ...Object.values(resolved.syntax),
  ].join("|");
}

/** A Shiki-safe theme name carrying the fingerprint, so two edits never share one. */
export function shikiThemeName(resolved: ResolvedAdeTheme): string {
  return `ade-theme-${codeThemeFingerprint(resolved).replace(/[^a-zA-Z0-9]+/g, "-")}`;
}
