/**
 * Best-effort VS Code theme import.
 *
 * A VS Code theme describes a workbench in its own vocabulary — `colors` keys
 * like `editor.background` and `sideBar.background`, plus `tokenColors` for
 * syntax highlighting. ADE's format is a much smaller semantic palette, so this
 * maps the keys that translate cleanly and **says what it could not map**
 * instead of pretending to full fidelity. A VS Code theme imported here gets a
 * coherent ADE theme; it does not get VS Code's syntax colours, and the caller
 * shows the user the leftover keys.
 *
 * The mapping is deliberately first-match-wins per ADE token, and only the
 * colour keys a human would recognize as "the surface / the text / the accent"
 * are consumed. Everything else is reported as unmapped.
 */

import { parseColor, relativeLuminance, toHex } from "./color";
import { slugifyThemeId } from "./validate";
import {
  ADE_THEME_FORMAT_VERSION,
  ADE_THEME_NAME_MAX_LENGTH,
  type AdeTerminalAnsiKey,
  type AdeTerminalPalette,
  type AdeTheme,
  type AdeThemePalette,
  type AdeThemePaletteKey,
  type ThemeBaseMode,
} from "./types";

/** ADE palette token → the VS Code `colors` keys it may be read from, in order. */
export const VSCODE_COLOR_MAP: Partial<Record<AdeThemePaletteKey, readonly string[]>> = {
  bg: ["editor.background"],
  fg: ["editor.foreground"],
  surface: ["sideBar.background", "activityBar.background", "titleBar.activeBackground"],
  card: ["editorWidget.background", "panel.background", "quickInput.background"],
  surfaceRaised: ["editorHoverWidget.background", "menu.background"],
  surfaceRecessed: ["editorGroupHeader.tabsBackground", "statusBar.background"],
  popover: ["menu.background", "quickInput.background"],
  modal: ["editorWidget.background"],
  composer: ["input.background"],
  mutedFg: ["editorLineNumber.foreground", "descriptionForeground"],
  secondary: ["sideBarSectionHeader.background"],
  border: ["panel.border", "editorGroup.border", "sideBar.border", "input.border"],
  separator: ["panel.border"],
  separatorActive: ["focusBorder"],
  accent: ["focusBorder", "activityBarBadge.background", "button.background", "textLink.foreground"],
  accentFg: ["button.foreground", "activityBarBadge.foreground"],
  error: ["errorForeground", "editorError.foreground"],
  warning: ["editorWarning.foreground"],
  info: ["editorInfo.foreground"],
  success: ["terminal.ansiGreen"],
  diffAdd: ["diffEditor.insertedTextBackground"],
  diffDel: ["diffEditor.removedTextBackground"],
};

/** VS Code `terminal.ansi*` key → ADE ANSI slot. */
export const VSCODE_ANSI_MAP: Record<string, AdeTerminalAnsiKey> = {
  "terminal.ansiBlack": "black",
  "terminal.ansiRed": "red",
  "terminal.ansiGreen": "green",
  "terminal.ansiYellow": "yellow",
  "terminal.ansiBlue": "blue",
  "terminal.ansiMagenta": "magenta",
  "terminal.ansiCyan": "cyan",
  "terminal.ansiWhite": "white",
  "terminal.ansiBrightBlack": "brightBlack",
  "terminal.ansiBrightRed": "brightRed",
  "terminal.ansiBrightGreen": "brightGreen",
  "terminal.ansiBrightYellow": "brightYellow",
  "terminal.ansiBrightBlue": "brightBlue",
  "terminal.ansiBrightMagenta": "brightMagenta",
  "terminal.ansiBrightCyan": "brightCyan",
  "terminal.ansiBrightWhite": "brightWhite",
};

export type VscodeImportResult = {
  theme: AdeTheme;
  /** ADE palette tokens the import filled from the file. */
  mapped: AdeThemePaletteKey[];
  /** VS Code `colors` keys (and `tokenColors`) the import did not consume. */
  unmapped: string[];
};

function normalizeHex(value: unknown): string | null {
  const parsed = parseColor(value);
  return parsed ? toHex(parsed) : null;
}

/**
 * Convert a parsed VS Code theme into an ADE theme plus the list of what did
 * not map. Returns null when the input is not theme-shaped, or when it carries
 * neither `colors` nor `tokenColors`.
 */
export function importVscodeTheme(input: unknown, options: { name?: string } = {}): VscodeImportResult | null {
  let parsed: unknown = input;
  if (typeof input === "string") {
    try {
      parsed = JSON.parse(input);
    } catch {
      return null;
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const source = parsed as Record<string, unknown>;
  const colorsSource = source.colors && typeof source.colors === "object" && !Array.isArray(source.colors)
    ? (source.colors as Record<string, unknown>)
    : null;
  const hasTokenColors = Array.isArray(source.tokenColors);
  if (!colorsSource && !hasTokenColors) return null;

  const colors = colorsSource ?? {};
  const palette: AdeThemePalette = {};
  const mapped: AdeThemePaletteKey[] = [];
  const consumed = new Set<string>();

  for (const key of Object.keys(VSCODE_COLOR_MAP) as AdeThemePaletteKey[]) {
    for (const vscodeKey of VSCODE_COLOR_MAP[key] ?? []) {
      const hex = normalizeHex(colors[vscodeKey]);
      if (!hex) continue;
      palette[key] = hex;
      mapped.push(key);
      consumed.add(vscodeKey);
      break;
    }
  }

  const terminal: AdeTerminalPalette = {};
  let terminalMapped = false;
  for (const [vscodeKey, ansiKey] of Object.entries(VSCODE_ANSI_MAP)) {
    const hex = normalizeHex(colors[vscodeKey]);
    if (!hex) continue;
    terminal[ansiKey] = hex;
    consumed.add(vscodeKey);
    terminalMapped = true;
  }
  for (const [vscodeKey, ansiKey] of [
    ["terminal.background", "background"],
    ["terminal.foreground", "foreground"],
    ["terminalCursor.foreground", "cursor"],
  ] as const) {
    const hex = normalizeHex(colors[vscodeKey]);
    if (!hex) continue;
    terminal[ansiKey] = hex;
    consumed.add(vscodeKey);
    terminalMapped = true;
  }

  const unmapped = Object.keys(colors).filter((key) => !consumed.has(key));
  if (hasTokenColors) unmapped.push("tokenColors");

  const bg = parseColor(palette.bg ?? "");
  const baseMode: ThemeBaseMode = bg && relativeLuminance(bg) > 0.5 ? "light" : "dark";
  const name = (options.name?.trim() || (typeof source.name === "string" ? source.name.trim() : "") || "VS Code theme")
    .slice(0, ADE_THEME_NAME_MAX_LENGTH);

  const theme: AdeTheme = {
    formatVersion: ADE_THEME_FORMAT_VERSION,
    id: slugifyThemeId(name),
    name,
    baseMode,
    source: "vscode",
    palette,
    ...(terminalMapped ? { terminal } : {}),
  };
  return { theme, mapped, unmapped };
}
