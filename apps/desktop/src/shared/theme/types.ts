/**
 * The ADE theme data model.
 *
 * A theme is a small, semantic palette — not a dump of the ~200 CSS custom
 * properties the renderer happens to use today. The engine (`resolve.ts`) walks
 * from these tokens out to every `--color-*`, `--shell-*`, `--chat-*` and
 * `--work-*` variable, so a theme author (or an imported VS Code theme) only
 * has to answer questions a person can answer: what is the background, what is
 * the text, what is the accent.
 *
 * The shape is deliberately shared, versioned and serialisable, because the same
 * object travels three ways: persisted to the account settings store, written to
 * a `.json` file a user shares, and handed to the engine that paints the DOM.
 * No React, no `window`, no CSS in this module.
 */

/** Which structural half of index.css a theme's derived defaults come from. */
export type ThemeBaseMode = "dark" | "light";

/** Keep the historical name working — the base mode is what `data-theme` carries. */
export type ThemeId = ThemeBaseMode;

/** Where a theme came from. Drives the badge in the gallery and import policy. */
export type AdeThemeSource = "builtin" | "custom" | "imported" | "vscode";

/**
 * The semantic palette keys.
 *
 * Required is only the core a theme must state to exist (`bg`, `fg`, `surface`,
 * `card`, `accent`); every other key is derived from those when omitted, which
 * is what lets a one-line community colour scheme still render correctly.
 */
export const ADE_THEME_PALETTE_KEYS = [
  "bg",
  "canvas",
  "fg",
  "surface",
  "surfaceRaised",
  "surfaceRecessed",
  "surfaceOverlay",
  "card",
  "cardFg",
  "secondary",
  "secondaryFg",
  "muted",
  "mutedFg",
  "border",
  "separator",
  "separatorActive",
  "popover",
  "modal",
  "composer",
  "accent",
  "accentFg",
  "accentBright",
  "accentDeep",
  "accentMuted",
  "success",
  "warning",
  "error",
  "info",
  "diffAdd",
  "diffDel",
  "diffHunk",
] as const;

export type AdeThemePaletteKey = (typeof ADE_THEME_PALETTE_KEYS)[number];

/** The keys a theme must provide itself; everything else derives. */
export const ADE_THEME_REQUIRED_PALETTE_KEYS = ["bg", "fg", "surface", "card", "accent"] as const;

export type AdeThemePalette = Partial<Record<AdeThemePaletteKey, string>>;
export type ResolvedAdeThemePalette = Record<AdeThemePaletteKey, string>;

/** The 16 ANSI colours a terminal theme can pin. */
export const ADE_TERMINAL_ANSI_KEYS = [
  "black",
  "red",
  "green",
  "yellow",
  "blue",
  "magenta",
  "cyan",
  "white",
  "brightBlack",
  "brightRed",
  "brightGreen",
  "brightYellow",
  "brightBlue",
  "brightMagenta",
  "brightCyan",
  "brightWhite",
] as const;

export type AdeTerminalAnsiKey = (typeof ADE_TERMINAL_ANSI_KEYS)[number];

/** The ANSI palette plus the four structural terminal colours. */
export type AdeTerminalPalette = Partial<Record<AdeTerminalAnsiKey, string>> & {
  background?: string;
  foreground?: string;
  cursor?: string;
  cursorAccent?: string;
  selectionBackground?: string;
};

export type AdeTheme = {
  formatVersion: 1;
  /** Stable slug, unique across shipped and custom themes. */
  id: string;
  name: string;
  description?: string;
  author?: string;
  baseMode: ThemeBaseMode;
  source: AdeThemeSource;
  /** Shipped theme id this was derived from, when known. */
  basedOn?: string;
  palette: AdeThemePalette;
  terminal?: AdeTerminalPalette;
};

/** Practical bounds, enforced on load so a hostile file cannot redefine a layout. */
export const ADE_THEME_ID_MAX_LENGTH = 80;
export const ADE_THEME_NAME_MAX_LENGTH = 60;
export const ADE_THEME_DESCRIPTION_MAX_LENGTH = 200;
export const ADE_THEME_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

/** The worst-case contrast below which the customizer nudges the author. */
export type ThemeContrastIssue = {
  /** Human label, e.g. "Text on background". */
  label: string;
  foreground: string;
  background: string;
  ratio: number;
  threshold: number;
};

/** A theme parsed together with the derived values and warnings for its palette. */
export type ResolvedAdeTheme = {
  theme: AdeTheme;
  palette: ResolvedAdeThemePalette;
  terminal: AdeTerminalPalette;
  cssVars: Record<string, string>;
  contrastIssues: ThemeContrastIssue[];
};

export const ADE_THEME_FILE_KIND = "ade.theme";
export const ADE_THEME_FORMAT_VERSION = 1 as const;

/** The versioned envelope written by export and accepted by import. */
export type AdeThemeExport = {
  kind: typeof ADE_THEME_FILE_KIND;
  version: typeof ADE_THEME_FORMAT_VERSION;
  exportedAt: string;
  theme: AdeTheme;
};
