/**
 * Theme engine: semantic tokens in, CSS custom properties and an xterm palette
 * out.
 *
 * The renderer's stylesheet defines every `--color-*` variable twice, once per
 * structural half (`[data-theme="dark"]` / `[data-theme="light"]`). Most of the
 * derived surface — every `--shell-*`, `--chat-*` and `--work-*` token that is
 * written as `color-mix(in srgb, var(--color-accent) …)` — recomputes itself
 * from whatever `--color-*` values are in scope. That is the seam this module
 * leans on: a theme states a small semantic palette, the engine emits the
 * palette variables as inline `--color-*` overrides on `<html>`, and the
 * existing stylesheet derives the rest.
 *
 * Two rules keep it honest.
 *
 * **Built-in `dark` and `light` emit nothing.** They are the stylesheet's own
 * two blocks, so the engine must not shadow them — a derived value that was one
 * hex off would be a visual regression on every install. `resolveTheme` returns
 * an empty `cssVars` map for exactly those two ids and lets `data-theme` do the
 * work. Everything else (shipped extras, custom themes, imports) emits a
 * complete override set.
 *
 * **Missing tokens are derived, not required.** A theme has to state `bg`,
 * `fg`, `surface`, `card` and `accent`; its muted text, borders, raised
 * surfaces and status tones are computed from those. An imported VS Code theme
 * with a thin `colors` map therefore still produces a coherent ADE theme.
 */

import {
  colorToCssString,
  contrastRatio,
  mixColors,
  parseColor,
  readableForeground,
  shiftLightness,
  toHex,
  withAlpha,
  WCAG_AA_LARGE_CONTRAST,
  WCAG_AA_TEXT_CONTRAST,
  type Rgb,
} from "./color";
import {
  ADE_TERMINAL_ANSI_KEYS,
  ADE_THEME_PALETTE_KEYS,
  type AdeTheme,
  type AdeThemePalette,
  type AdeThemePaletteKey,
  type AdeTerminalPalette,
  type ResolvedAdeTheme,
  type ResolvedAdeThemePalette,
  type ThemeBaseMode,
  type ThemeContrastIssue,
} from "./types";

/** The two ids whose values live in `index.css` and must not be shadowed. */
export const STYLESHEET_THEME_IDS: readonly string[] = ["dark", "light"];

const BLACK: Rgb = { r: 0, g: 0, b: 0 };
const WHITE: Rgb = { r: 255, g: 255, b: 255 };

type ModeDefaults = {
  fg: string;
  bg: string;
  surface: string;
  card: string;
  accent: string;
  mutedFg: string;
  border: string;
  success: string;
  warning: string;
  error: string;
  info: string;
};

/** Fallbacks used when a theme omits a required token or states an unparsable one. */
export const THEME_BASE_DEFAULTS: Record<ThemeBaseMode, ModeDefaults> = {
  dark: {
    fg: "#F0F0F2",
    bg: "#0C0B10",
    surface: "#16141E",
    card: "#1A1830",
    accent: "#A78BFA",
    mutedFg: "#908FA0",
    border: "#302C42",
    success: "#22c55e",
    warning: "#f59e0b",
    error: "#ef4444",
    info: "#3b82f6",
  },
  light: {
    fg: "#1a1a1e",
    bg: "#f5f3f0",
    surface: "#faf8f5",
    card: "#ffffff",
    accent: "#049068",
    mutedFg: "#636370",
    border: "#d6d3ce",
    success: "#16a34a",
    warning: "#d97706",
    error: "#dc2626",
    info: "#2563eb",
  },
};

function rgb(input: string, fallback: Rgb): Rgb {
  return parseColor(input) ?? fallback;
}

function hexOf(input: string, fallback: Rgb): string {
  return toHex(rgb(input, fallback));
}

function css(input: string, fallback: Rgb): string {
  return colorToCssString(rgb(input, fallback));
}

function alphaCss(input: string, alpha: number, fallback: Rgb): string {
  return colorToCssString(withAlpha(rgb(input, fallback), alpha));
}

/** sRGB triplet string for `--color-card-rgb`, which some surfaces use as `rgb(var(…))`. */
function rgbTriplet(input: string, fallback: Rgb): string {
  const c = rgb(input, fallback);
  return `${c.r}, ${c.g}, ${c.b}`;
}

/**
 * Fill every omitted palette key from the core five plus the base mode.
 *
 * The ratios are the ones the shipped dark/light blocks already use, expressed
 * against the theme's own colours rather than hard-coded greys, so a warm
 * theme gets warm muted text and a cool theme gets cool muted text.
 */
export function resolvePalette(theme: AdeTheme): ResolvedAdeThemePalette {
  const mode = theme.baseMode;
  const defaults = THEME_BASE_DEFAULTS[mode];
  const isDark = mode === "dark";
  const source: AdeThemePalette = theme.palette ?? {};

  const bg = hexOf(source.bg ?? defaults.bg, rgb(defaults.bg, BLACK));
  const fg = hexOf(source.fg ?? defaults.fg, rgb(defaults.fg, WHITE));
  const surface = hexOf(source.surface ?? defaults.surface, rgb(defaults.surface, BLACK));
  const card = hexOf(source.card ?? defaults.card, rgb(defaults.card, BLACK));
  const accent = hexOf(source.accent ?? defaults.accent, rgb(defaults.accent, BLACK));

  const bgRgb = rgb(bg, BLACK);
  const fgRgb = rgb(fg, WHITE);
  const surfaceRgb = rgb(surface, BLACK);
  const cardRgb = rgb(card, BLACK);
  const accentRgb = rgb(accent, BLACK);

  const mixOnFg = (ratio: number): string => toHex(mixColors(fgRgb, bgRgb, ratio));

  const derived: Record<AdeThemePaletteKey, string> = {
    bg,
    canvas: source.canvas ? hexOf(source.canvas, bgRgb) : isDark ? toHex(shiftLightness(bgRgb, 0.012)) : bg,
    fg,
    surface,
    surfaceRaised: source.surfaceRaised
      ? hexOf(source.surfaceRaised, surfaceRgb)
      : isDark
        ? toHex(shiftLightness(surfaceRgb, 0.035))
        : card,
    surfaceRecessed: source.surfaceRecessed
      ? hexOf(source.surfaceRecessed, surfaceRgb)
      : isDark
        ? toHex(shiftLightness(surfaceRgb, -0.03))
        : toHex(mixColors(bgRgb, BLACK, 0.94)),
    surfaceOverlay: source.surfaceOverlay
      ? colorToCssString(rgb(source.surfaceOverlay, cardRgb))
      : isDark
        ? toHex(shiftLightness(surfaceRgb, 0.04))
        : colorToCssString(withAlpha(cardRgb, 0.92)),
    card,
    cardFg: source.cardFg ? hexOf(source.cardFg, fgRgb) : fg,
    secondary: source.secondary
      ? hexOf(source.secondary, surfaceRgb)
      : isDark
        ? toHex(shiftLightness(surfaceRgb, 0.05))
        : toHex(mixColors(bgRgb, BLACK, 0.93)),
    secondaryFg: source.secondaryFg ? hexOf(source.secondaryFg, rgb(defaults.mutedFg, WHITE)) : mixOnFg(isDark ? 0.6 : 0.62),
    muted: source.muted
      ? hexOf(source.muted, surfaceRgb)
      : isDark
        ? toHex(shiftLightness(surfaceRgb, 0.028))
        : toHex(mixColors(bgRgb, BLACK, 0.96)),
    mutedFg: source.mutedFg ? hexOf(source.mutedFg, rgb(defaults.mutedFg, WHITE)) : mixOnFg(isDark ? 0.58 : 0.6),
    border: source.border ? hexOf(source.border, rgb(defaults.border, BLACK)) : mixOnFg(isDark ? 0.17 : 0.15),
    separator: source.separator ? hexOf(source.separator, rgb(defaults.border, BLACK)) : mixOnFg(isDark ? 0.17 : 0.13),
    separatorActive: source.separatorActive ? hexOf(source.separatorActive, accentRgb) : accent,
    popover: source.popover ? hexOf(source.popover, surfaceRgb) : isDark ? toHex(shiftLightness(surfaceRgb, 0.02)) : card,
    modal: source.modal ? hexOf(source.modal, cardRgb) : card,
    composer: source.composer ? hexOf(source.composer, surfaceRgb) : isDark ? toHex(shiftLightness(surfaceRgb, -0.01)) : card,
    accent,
    accentFg: source.accentFg
      ? hexOf(source.accentFg, accentRgb)
      : toHex(readableForeground(accentRgb, [WHITE, { r: 12, g: 11, b: 16 }])),
    accentBright: source.accentBright ? hexOf(source.accentBright, accentRgb) : toHex(shiftLightness(accentRgb, isDark ? 0.09 : 0.12)),
    accentDeep: source.accentDeep ? hexOf(source.accentDeep, accentRgb) : toHex(shiftLightness(accentRgb, -0.12)),
    accentMuted: source.accentMuted
      ? colorToCssString(rgb(source.accentMuted, accentRgb))
      : colorToCssString(withAlpha(accentRgb, isDark ? 0.2 : 0.1)),
    success: hexOf(source.success ?? defaults.success, rgb(defaults.success, BLACK)),
    warning: hexOf(source.warning ?? defaults.warning, rgb(defaults.warning, BLACK)),
    error: hexOf(source.error ?? defaults.error, rgb(defaults.error, BLACK)),
    info: hexOf(source.info ?? defaults.info, rgb(defaults.info, BLACK)),
    diffAdd: source.diffAdd ? hexOf(source.diffAdd, rgb(defaults.success, BLACK)) : hexOf(source.success ?? defaults.success, rgb(defaults.success, BLACK)),
    diffDel: source.diffDel ? hexOf(source.diffDel, rgb(defaults.error, BLACK)) : hexOf(source.error ?? defaults.error, rgb(defaults.error, BLACK)),
    diffHunk: source.diffHunk ? hexOf(source.diffHunk, rgb(defaults.info, BLACK)) : hexOf(source.info ?? defaults.info, rgb(defaults.info, BLACK)),
  };

  // Guard against a palette that omits a key entirely (a hand-written object
  // rather than one run through `normalizeAdeTheme`).
  for (const key of ADE_THEME_PALETTE_KEYS) {
    if (!derived[key]) derived[key] = defaults[key as keyof ModeDefaults] ?? "#000000";
  }
  return derived;
}

/**
 * Every CSS custom property a non-stylesheet theme overrides.
 *
 * Shell, work and chat tokens whose stylesheet definition is already a
 * `color-mix`/`var()` expression are intentionally absent: they recompute from
 * the `--color-*` values emitted here. Tokens that are hard-coded rgba/hex in
 * either block are emitted, because otherwise a custom background would leave a
 * stale dark strip behind.
 */
export function resolveCssVars(theme: AdeTheme, palette: ResolvedAdeThemePalette): Record<string, string> {
  const mode = theme.baseMode;
  const isDark = mode === "dark";
  const p = palette;
  const fg = p.fg;
  const accent = p.accent;
  const bg = p.bg;
  const card = p.card;
  const surface = p.surface;

  const darkShadow = (a: number): string => `rgba(0, 0, 0, ${a})`;

  const vars: Record<string, string> = {
    "--color-bg": p.bg,
    "--chat-canvas-bg": p.canvas,
    "--color-fg": p.fg,
    "--color-surface": p.surface,
    "--color-card": p.card,
    "--color-card-fg": p.cardFg,
    "--color-card-rgb": rgbTriplet(p.card, BLACK),
    "--color-secondary": p.secondary,
    "--color-secondary-fg": p.secondaryFg,
    "--color-muted": p.muted,
    "--color-muted-fg": p.mutedFg,
    "--color-border": p.border,
    "--color-accent": p.accent,
    "--color-accent-fg": p.accentFg,
    "--color-accent-muted": p.accentMuted,
    "--color-accent-bright": p.accentBright,
    "--color-accent-deep": p.accentDeep,
    "--color-accent-glow-strong": alphaCss(p.accentBright, 0.22, rgb(p.accentBright, BLACK)),
    "--color-surface-raised": p.surfaceRaised,
    "--color-surface-recessed": p.surfaceRecessed,
    "--color-surface-overlay": p.surfaceOverlay,
    "--color-popup-bg": p.popover,
    "--color-modal-bg": p.modal,
    "--color-composer-bg": p.composer,
    "--color-glass-card": isDark ? alphaCss(card, 0.85, rgb(card, BLACK)) : alphaCss(card, 0.9, rgb(card, BLACK)),
    "--color-separator": p.separator,
    "--color-separator-active": p.separatorActive,
    "--border-separator": p.border,
    "--color-glow": alphaCss(accent, isDark ? 0.22 : 0.12, rgb(accent, BLACK)),

    "--gradient-accent": `linear-gradient(135deg, ${p.accentDeep}, ${p.accent})`,
    "--gradient-accent-soft": `linear-gradient(135deg, ${alphaCss(p.accentDeep, 0.2, rgb(p.accentDeep, BLACK))}, ${alphaCss(accent, 0.1, rgb(accent, BLACK))})`,
    "--gradient-popup-border": `linear-gradient(180deg, ${alphaCss(accent, 0.2, rgb(accent, BLACK))}, ${alphaCss(p.accentDeep, 0.1, rgb(p.accentDeep, BLACK))})`,
    "--gradient-surface": isDark
      ? `linear-gradient(180deg, ${surface} 0%, ${bg} 100%)`
      : `linear-gradient(180deg, ${p.surfaceRaised}, ${bg})`,
    "--gradient-panel": isDark
      ? `linear-gradient(180deg, ${p.surfaceRaised} 0%, ${surface} 100%)`
      : `linear-gradient(180deg, ${card} 0%, ${surface} 100%)`,

    "--shadow-card": (isDark
      ? [darkShadow(0.6), `0 0 0 1px ${alphaCss(p.border, 0.25, rgb(p.border, BLACK))}`]
      : ["0 4px 16px -4px rgba(0, 0, 0, 0.08)", "0 1px 3px -1px rgba(0, 0, 0, 0.05)"]).join(", "),
    "--shadow-card-hover": (isDark
      ? [darkShadow(0.7), `0 0 0 1px ${alphaCss(accent, 0.15, rgb(accent, BLACK))}`]
      : ["0 8px 24px -8px rgba(0, 0, 0, 0.12)", `0 0 0 1px ${alphaCss(accent, 0.18, rgb(accent, BLACK))}`]).join(", "),
    "--shadow-float": (isDark
      ? [darkShadow(0.8), `0 0 0 1px ${alphaCss(accent, 0.08, rgb(accent, BLACK))}`]
      : ["0 20px 50px -16px rgba(0, 0, 0, 0.12)", `0 0 0 1px ${alphaCss(accent, 0.08, rgb(accent, BLACK))}`]).join(", "),
    "--shadow-popup": (isDark
      ? [darkShadow(0.55), `0 0 0 1px ${alphaCss(accent, 0.12, rgb(accent, BLACK))}`]
      : ["0 20px 50px -12px rgba(0, 0, 0, 0.12)", `0 0 0 1px ${alphaCss(p.border, 0.7, rgb(p.border, BLACK))}`]).join(", "),
    "--shadow-modal": (isDark
      ? [darkShadow(0.67), `0 0 0 1px ${alphaCss(accent, 0.1, rgb(accent, BLACK))}`]
      : ["0 28px 64px -16px rgba(0, 0, 0, 0.18)", `0 0 0 1px ${alphaCss(p.border, 0.7, rgb(p.border, BLACK))}`]).join(", "),
    "--shadow-panel": isDark
      ? "0 2px 12px -2px rgba(0, 0, 0, 0.6)"
      : "0 4px 16px -4px rgba(0, 0, 0, 0.08), 0 1px 3px -1px rgba(0, 0, 0, 0.05)",
    "--shadow-inset": isDark ? "inset 0 1px 2px rgba(0, 0, 0, 0.5)" : "inset 0 1px 3px rgba(0, 0, 0, 0.06)",
    "--shadow-separator": isDark ? "inset 0 0 4px 0 rgba(0, 0, 0, 0.4)" : "inset 0 0 4px 0 rgba(0, 0, 0, 0.06)",

    "--pane-bg": isDark ? alphaCss(card, 0.94, rgb(card, BLACK)) : alphaCss(card, 0.88, rgb(card, BLACK)),
    "--pane-border": isDark ? alphaCss(p.border, 0.6, rgb(p.border, BLACK)) : alphaCss(p.border, 0.5, rgb(p.border, BLACK)),

    "--chat-shell-shadow": isDark
      ? [`0 24px 64px -34px ${darkShadow(0.85)}`, `0 0 0 1px ${alphaCss(accent, 0.12, rgb(accent, BLACK))}`].join(", ")
      : [`0 18px 42px -28px rgba(15, 23, 42, 0.18)`, `0 0 0 1px ${alphaCss(accent, 0.1, rgb(accent, BLACK))}`].join(", "),
    "--chat-card-shadow": isDark ? "0 16px 32px -24px rgba(0, 0, 0, 0.7)" : "0 14px 28px -24px rgba(15, 23, 42, 0.14)",
    "--chat-composer-shadow": isDark ? "0 -12px 30px -26px rgba(0, 0, 0, 0.7)" : "0 -12px 22px -24px rgba(15, 23, 42, 0.12)",

    "--chat-glass-bg": isDark ? alphaCss(p.composer, 0.75, rgb(p.composer, BLACK)) : alphaCss(card, 0.76, rgb(card, BLACK)),
    "--chat-glass-border": alphaCss(fg, isDark ? 0.08 : 0.08, WHITE),
    "--chat-glass-highlight": isDark ? alphaCss(fg, 0.1, WHITE) : alphaCss(toHex(WHITE), 0.65, WHITE),
    "--chat-glass-lowlight": isDark ? "rgba(10, 8, 18, 0.34)" : "rgba(182, 190, 204, 0.14)",
    "--chat-glass-sheen": alphaCss(accent, isDark ? 0.1 : 0.08, rgb(accent, BLACK)),
    "--chat-panel-bg": isDark ? alphaCss(p.composer, 0.85, rgb(p.composer, BLACK)) : alphaCss(card, 0.82, rgb(card, BLACK)),
    "--chat-panel-border": alphaCss(fg, isDark ? 0.1 : 0.1, WHITE),
    "--chat-panel-bg-strong": isDark ? alphaCss(card, 0.92, rgb(card, BLACK)) : alphaCss(card, 0.92, rgb(card, BLACK)),
    "--chat-streaming-shimmer": `linear-gradient(90deg, transparent, ${alphaCss(fg, isDark ? 0.07 : 0.08, WHITE)}, transparent)`,
    "--chat-block-bg": isDark ? "rgba(0, 0, 0, 0.25)" : "rgba(15, 23, 42, 0.04)",
    "--chat-block-border": alphaCss(fg, isDark ? 0.06 : 0.08, WHITE),
    "--chat-inline-code-bg": isDark ? "rgba(0, 0, 0, 0.30)" : "rgba(15, 23, 42, 0.06)",
    "--chat-table-border": alphaCss(fg, isDark ? 0.08 : 0.1, WHITE),
    "--chat-copy-button-bg": alphaCss(fg, isDark ? 0.03 : 0.04, WHITE),
    "--chat-copy-button-border": alphaCss(fg, isDark ? 0.08 : 0.1, WHITE),
    "--chat-copy-button-fg": alphaCss(fg, isDark ? 0.45 : 0.55, WHITE),
    "--chat-copy-button-hover-bg": alphaCss(fg, isDark ? 0.05 : 0.07, WHITE),
    "--chat-copy-button-hover-border": alphaCss(fg, isDark ? 0.14 : 0.18, WHITE),
    "--chat-copy-button-hover-fg": alphaCss(fg, isDark ? 0.72 : 0.8, WHITE),

    "--pr-surface": p.canvas,
    "--pr-thread-card": p.card,
    "--pr-panel-card": toHex(mixColors(rgb(accent, BLACK), rgb(card, BLACK), 0.06)),

    "--blur-popup": "40px",
    "--blur-modal": "60px",

    "--work-pane-border": alphaCss(fg, isDark ? 0.06 : 0.07, WHITE),
    "--work-pane-header-bg": alphaCss(fg, isDark ? 0.03 : 0.06, WHITE),
    "--work-sidebar-bg": isDark ? toHex(mixColors(rgb(fg, WHITE), rgb(bg, BLACK), 0.04)) : toHex(mixColors(rgb(card, WHITE), rgb(bg, BLACK), 0.6)),
    "--work-session-sidebar-bg": isDark ? toHex(shiftLightness(rgb(bg, BLACK), -0.012)) : toHex(mixColors(rgb(card, WHITE), rgb(bg, BLACK), 0.6)),
    "--work-popover-bg": alphaCss(surface, 0.96, rgb(surface, BLACK)),
    "--work-popover-border": alphaCss(fg, 0.1, WHITE),
    "--work-popover-shadow": isDark
      ? `0 12px 40px -12px ${darkShadow(0.5)}, 0 0 0 1px ${alphaCss(fg, 0.06, WHITE)}`
      : `0 8px 24px -8px rgba(0, 0, 0, 0.15), 0 0 0 1px ${alphaCss(p.border, 0.88, rgb(p.border, BLACK))}`,
    "--work-popover-item-hover": alphaCss(fg, isDark ? 0.06 : 0.08, WHITE),
    "--work-popover-item-active": alphaCss(fg, isDark ? 0.08 : 0.1, WHITE),

    "--color-success": p.success,
    "--color-warning": p.warning,
    "--color-error": p.error,
    "--color-info": p.info,
    "--color-diff-add": p.diffAdd,
    "--color-diff-del": p.diffDel,
    "--color-diff-hunk": p.diffHunk,
  };

  return vars;
}

const ANSI_DARK: Record<string, string> = {
  black: "#3f3f46",
  red: "#f87171",
  green: "#4ade80",
  yellow: "#facc15",
  blue: "#60a5fa",
  magenta: "#c084fc",
  cyan: "#22d3ee",
  white: "#e4e4e7",
  brightBlack: "#71717a",
  brightRed: "#fca5a5",
  brightGreen: "#86efac",
  brightYellow: "#fde047",
  brightBlue: "#93c5fd",
  brightMagenta: "#d8b4fe",
  brightCyan: "#67e8f9",
  brightWhite: "#fafafa",
};

const ANSI_LIGHT: Record<string, string> = {
  black: "#27272a",
  red: "#dc2626",
  green: "#16a34a",
  yellow: "#ca8a04",
  blue: "#2563eb",
  magenta: "#9333ea",
  cyan: "#0891b2",
  white: "#e4e4e7",
  brightBlack: "#52525b",
  brightRed: "#ef4444",
  brightGreen: "#22c55e",
  brightYellow: "#eab308",
  brightBlue: "#3b82f6",
  brightMagenta: "#a855f7",
  brightCyan: "#06b6d4",
  brightWhite: "#fafafa",
};

/** The xterm theme for a resolved palette, defaulting ANSI from the base mode. */
export function resolveTerminalPalette(theme: AdeTheme, palette: ResolvedAdeThemePalette): AdeTerminalPalette {
  const isDark = theme.baseMode === "dark";
  const ansiDefaults = isDark ? ANSI_DARK : ANSI_LIGHT;
  const source = theme.terminal ?? {};
  const out: AdeTerminalPalette = {
    background: source.background ? css(source.background, rgb(palette.canvas, BLACK)) : palette.canvas,
    foreground: source.foreground ? css(source.foreground, rgb(palette.fg, WHITE)) : palette.fg,
    cursor: source.cursor ? css(source.cursor, rgb(palette.accent, BLACK)) : palette.accent,
    cursorAccent: source.cursorAccent ? css(source.cursorAccent, rgb(palette.bg, BLACK)) : palette.bg,
    selectionBackground: source.selectionBackground
      ? css(source.selectionBackground, rgb(palette.accent, BLACK))
      : colorToCssString(withAlpha(rgb(palette.accent, BLACK), 0.26)),
  };
  for (const key of ADE_TERMINAL_ANSI_KEYS) {
    const value = source[key];
    out[key] = value ? css(value, rgb(ansiDefaults[key] ?? palette.fg, WHITE)) : ansiDefaults[key];
  }
  return out;
}

/** Contrast pairs the customizer reports on; only below-threshold pairs surface. */
function collectContrastIssues(palette: ResolvedAdeThemePalette): ThemeContrastIssue[] {
  const issues: ThemeContrastIssue[] = [];
  const add = (label: string, fgKey: AdeThemePaletteKey, bgKey: AdeThemePaletteKey, threshold: number) => {
    const fg = parseColor(palette[fgKey]);
    const bg = parseColor(palette[bgKey]);
    if (!fg || !bg) return;
    const ratio = contrastRatio(fg, bg);
    if (ratio + 1e-6 < threshold) {
      issues.push({
        label,
        foreground: palette[fgKey],
        background: palette[bgKey],
        ratio: Math.round(ratio * 100) / 100,
        threshold,
      });
    }
  };
  add("Text on background", "fg", "bg", WCAG_AA_TEXT_CONTRAST);
  add("Text on card", "fg", "card", WCAG_AA_TEXT_CONTRAST);
  add("Muted text on background", "mutedFg", "bg", WCAG_AA_TEXT_CONTRAST);
  add("Accent label on background", "accent", "bg", WCAG_AA_LARGE_CONTRAST);
  add("Text on accent", "accentFg", "accent", WCAG_AA_LARGE_CONTRAST);
  return issues;
}

/** Resolve a theme to the exact values the renderer applies. */
export function resolveTheme(theme: AdeTheme): ResolvedAdeTheme {
  const palette = resolvePalette(theme);
  const cssVars =
    theme.source === "builtin" && STYLESHEET_THEME_IDS.includes(theme.id)
      ? {}
      : resolveCssVars(theme, palette);
  return {
    theme,
    palette,
    terminal: resolveTerminalPalette(theme, palette),
    cssVars,
    contrastIssues: collectContrastIssues(palette),
  };
}
