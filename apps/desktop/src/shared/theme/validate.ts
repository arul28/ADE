/**
 * Theme parsing, repair and the import/export envelope.
 *
 * Everything here is defensive on purpose. A theme can arrive from a user's
 * localStorage that predates the format, from a synced account row written by a
 * newer ADE, or from a `.json` file some stranger on the internet shared. None
 * of those are allowed to crash the app, and none of them is allowed to smuggle
 * a value the engine will then write into a CSS custom property.
 *
 * The rule is **repair, never throw**: unknown palette keys are dropped, a
 * colour that will not parse is dropped (the resolver derives a replacement), a
 * bad id becomes a slug of the name, and a file from a future format version is
 * the one thing refused outright — because repairing it would silently discard
 * whatever it gained.
 */

import { isParsableColor, parseColor, relativeLuminance, toHex } from "./color";
import {
  ADE_TERMINAL_ANSI_KEYS,
  ADE_THEME_DESCRIPTION_MAX_LENGTH,
  ADE_THEME_FILE_KIND,
  ADE_THEME_FORMAT_VERSION,
  ADE_THEME_ID_MAX_LENGTH,
  ADE_THEME_ID_PATTERN,
  ADE_THEME_NAME_MAX_LENGTH,
  ADE_THEME_PALETTE_KEYS,
  type AdeTerminalPalette,
  type AdeTheme,
  type AdeThemeExport,
  type AdeThemePalette,
  type AdeThemePaletteKey,
  type AdeThemeSource,
  type ThemeBaseMode,
} from "./types";

const THEME_SOURCES: readonly AdeThemeSource[] = ["builtin", "custom", "imported", "vscode"];

/** How many custom themes one account can hold. A bound, not a quota. */
export const ADE_THEME_MAX_CUSTOM = 100;

export function isAdeThemeSource(value: unknown): value is AdeThemeSource {
  return typeof value === "string" && (THEME_SOURCES as readonly string[]).includes(value);
}

/**
 * Turn any human name into a stable, safe id.
 *
 * The id becomes part of a `data-theme-id` attribute and an account-settings
 * key, so it is restricted to lower-case alphanumerics and hyphens.
 */
export function slugifyThemeId(input: string): string {
  const slug = input
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, ADE_THEME_ID_MAX_LENGTH)
    .replace(/-+$/g, "");
  return slug || "theme";
}

/** A stable id that does not collide with one already in use. */
export function uniqueThemeId(base: string, taken: Iterable<string>): string {
  const root = slugifyThemeId(base);
  const used = new Set(taken);
  if (!used.has(root)) return root;
  let index = 2;
  while (used.has(`${root}-${index}`)) index += 1;
  return `${root}-${index}`;
}

function normalizePaletteEntry(value: unknown): string | null {
  if (!isParsableColor(value)) return null;
  const parsed = parseColor(value);
  if (!parsed) return null;
  // Store canonical hex for opaque colours, `rgba()` for translucent ones, so a
  // theme round-trips byte-for-byte instead of drifting on each save.
  if (parsed.a >= 1) return toHex(parsed);
  return `rgba(${parsed.r}, ${parsed.g}, ${parsed.b}, ${Math.round(parsed.a * 1000) / 1000})`;
}

function normalizePalette(value: unknown): AdeThemePalette {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const source = value as Record<string, unknown>;
  const palette: AdeThemePalette = {};
  for (const key of ADE_THEME_PALETTE_KEYS) {
    const normalized = normalizePaletteEntry(source[key]);
    if (normalized) palette[key] = normalized;
  }
  return palette;
}

function normalizeTerminal(value: unknown): AdeTerminalPalette | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const source = value as Record<string, unknown>;
  const terminal: AdeTerminalPalette = {};
  let any = false;
  for (const key of [...ADE_TERMINAL_ANSI_KEYS, "background", "foreground", "cursor", "cursorAccent", "selectionBackground"] as const) {
    const normalized = normalizePaletteEntry(source[key]);
    if (normalized) {
      (terminal as Record<string, string>)[key] = normalized;
      any = true;
    }
  }
  return any ? terminal : undefined;
}

function inferBaseMode(palette: AdeThemePalette): ThemeBaseMode {
  const bg = parseColor(palette.bg);
  if (!bg) return "dark";
  return relativeLuminance(bg) > 0.5 ? "light" : "dark";
}

/** True if a colour is present and real, so the resolver can be trusted with it. */
export function isUsablePaletteColor(value: unknown): boolean {
  return isParsableColor(value);
}

export type NormalizeThemeOptions = {
  /** Source to assign when the value does not carry a valid one. */
  source?: AdeThemeSource;
  /** Id to force (used when re-importing under a new name). */
  id?: string;
};

/**
 * Coerce anything into an `AdeTheme`, or return null when it is not even
 * theme-shaped (no object, no name and no id).
 */
export function normalizeAdeTheme(value: unknown, options: NormalizeThemeOptions = {}): AdeTheme | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;

  const rawName = typeof source.name === "string" ? source.name.trim() : "";
  const rawId = typeof source.id === "string" ? source.id.trim() : "";
  if (!rawName && !rawId) return null;

  const name = (rawName || rawId).slice(0, ADE_THEME_NAME_MAX_LENGTH);
  const requestedId = options.id ?? rawId;
  const id = ADE_THEME_ID_PATTERN.test(requestedId)
    ? requestedId.slice(0, ADE_THEME_ID_MAX_LENGTH)
    : slugifyThemeId(requestedId || name);

  const palette = normalizePalette(source.palette);
  const explicitMode = source.baseMode === "light" ? "light" : source.baseMode === "dark" ? "dark" : null;
  const baseMode = explicitMode ?? inferBaseMode(palette);

  const descriptionRaw = typeof source.description === "string" ? source.description.trim() : "";
  const authorRaw = typeof source.author === "string" ? source.author.trim() : "";
  const basedOnRaw = typeof source.basedOn === "string" ? source.basedOn.trim() : "";
  const terminal = normalizeTerminal(source.terminal);

  return {
    formatVersion: ADE_THEME_FORMAT_VERSION,
    id,
    name,
    ...(descriptionRaw ? { description: descriptionRaw.slice(0, ADE_THEME_DESCRIPTION_MAX_LENGTH) } : {}),
    ...(authorRaw ? { author: authorRaw.slice(0, ADE_THEME_NAME_MAX_LENGTH) } : {}),
    baseMode,
    source: options.source ?? (isAdeThemeSource(source.source) ? source.source : "custom"),
    ...(basedOnRaw ? { basedOn: basedOnRaw.slice(0, ADE_THEME_ID_MAX_LENGTH) } : {}),
    palette,
    ...(terminal ? { terminal } : {}),
  };
}

/** The palette keys a theme still needs before the resolver can paint well. */
export function missingCorePaletteKeys(theme: AdeTheme): AdeThemePaletteKey[] {
  const required: AdeThemePaletteKey[] = ["bg", "fg", "surface", "card", "accent"];
  return required.filter((key) => !isParsableColor(theme.palette[key]));
}

/** Normalize a persisted list, dropping duplicates by id and repairing entries. */
export function normalizeAdeThemeList(value: unknown): AdeTheme[] {
  if (!Array.isArray(value)) return [];
  const out: AdeTheme[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    const theme = normalizeAdeTheme(entry, { source: "custom" });
    if (!theme || seen.has(theme.id)) continue;
    seen.add(theme.id);
    out.push(theme);
    if (out.length >= ADE_THEME_MAX_CUSTOM) break;
  }
  return out;
}

export type ParseThemeFileResult =
  | { ok: true; theme: AdeTheme }
  | { ok: false; error: string };

/** The versioned envelope for a shared theme file. */
export function exportAdeTheme(theme: AdeTheme, now: Date = new Date()): AdeThemeExport {
  return {
    kind: ADE_THEME_FILE_KIND,
    version: ADE_THEME_FORMAT_VERSION,
    exportedAt: now.toISOString(),
    theme: {
      formatVersion: ADE_THEME_FORMAT_VERSION,
      id: theme.id,
      name: theme.name,
      ...(theme.description ? { description: theme.description } : {}),
      ...(theme.author ? { author: theme.author } : {}),
      baseMode: theme.baseMode,
      source: "custom",
      ...(theme.basedOn ? { basedOn: theme.basedOn } : {}),
      palette: { ...theme.palette },
      ...(theme.terminal ? { terminal: { ...theme.terminal } } : {}),
    },
  };
}

export function serializeAdeTheme(theme: AdeTheme, now: Date = new Date()): string {
  return `${JSON.stringify(exportAdeTheme(theme, now), null, 2)}\n`;
}

/**
 * Accept either a versioned envelope or a bare theme object.
 *
 * A `version` above the one this build understands is refused: the file may
 * carry tokens this engine would drop, and a silently downgraded theme is worse
 * than an honest "this needs a newer ADE".
 */
export function parseAdeThemeFile(raw: unknown): ParseThemeFileResult {
  let parsed: unknown = raw;
  if (typeof raw === "string") {
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { ok: false, error: "That file is not valid JSON." };
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, error: "That file does not contain a theme." };
  }
  const envelope = parsed as Record<string, unknown>;
  const version = envelope.version;
  if (typeof version === "number" && version > ADE_THEME_FORMAT_VERSION) {
    return { ok: false, error: `This theme needs a newer version of ADE (file version ${version}).` };
  }
  const candidate = envelope.theme ?? parsed;
  const theme = normalizeAdeTheme(candidate, { source: "custom" });
  if (!theme) return { ok: false, error: "That file does not contain a theme." };
  return { ok: true, theme };
}

/** A filesystem-safe file name for a theme export. */
export function themeExportFileName(theme: AdeTheme): string {
  return `ade-theme-${slugifyThemeId(theme.id || theme.name)}.json`;
}
