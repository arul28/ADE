/**
 * The builder every shipped theme family is written with.
 *
 * It lives apart from the library so each collection of families can be its own
 * file without the files importing each other in a circle.
 */

import type {
  AdeSyntaxPalette,
  AdeTerminalPalette,
  AdeTheme,
  AdeThemeFlair,
  AdeThemePalette,
  ThemeBaseMode,
} from "./types";

/** Which shelf of the gallery a family sits on. */
export type ThemeCollection = "ade" | "originals" | "classics";

export const THEME_COLLECTIONS: readonly { id: ThemeCollection; label: string; blurb: string }[] = [
  { id: "ade", label: "ADE", blurb: "Quiet palettes, made to live in all day." },
  { id: "originals", label: "Originals", blurb: "Made for ADE, with their own shapes, type and light." },
  { id: "classics", label: "Editor classics", blurb: "The colour schemes you already know, with their code colours." },
];

export type AdeThemeFamily = {
  id: string;
  name: string;
  collection: ThemeCollection;
  /** Extra words the gallery search matches, beyond the name and descriptions. */
  tags: readonly string[];
  dark: AdeTheme;
  light: AdeTheme;
};

/** What one variant of a family states. */
export type AdeThemeVariantInput = {
  description: string;
  palette: AdeThemePalette;
  /** Overrides the default id (`<family>-<mode>`); the ADE family keeps `dark` and `light`. */
  id?: string;
  /** Overrides the default name (`<Family> Dark`), for a scheme whose light half has its own name. */
  name?: string;
  terminal?: AdeTerminalPalette;
  syntax?: AdeSyntaxPalette;
  flair?: AdeThemeFlair;
};

function variant(familyId: string, familyName: string, mode: ThemeBaseMode, input: AdeThemeVariantInput): AdeTheme {
  const id = input.id ?? `${familyId}-${mode}`;
  return {
    formatVersion: 1,
    id,
    name: input.name ?? `${familyName} ${mode === "dark" ? "Dark" : "Light"}`,
    description: input.description,
    baseMode: mode,
    source: "builtin",
    ...(id === mode ? {} : { basedOn: mode }),
    palette: input.palette,
    ...(input.terminal ? { terminal: input.terminal } : {}),
    ...(input.syntax ? { syntax: input.syntax } : {}),
    ...(input.flair ? { flair: input.flair } : {}),
  };
}

export function family(
  id: string,
  name: string,
  dark: AdeThemeVariantInput,
  light: AdeThemeVariantInput,
  options: { collection?: ThemeCollection; tags?: readonly string[] } = {},
): AdeThemeFamily {
  return {
    id,
    name,
    collection: options.collection ?? "ade",
    tags: options.tags ?? [],
    dark: variant(id, name, "dark", dark),
    light: variant(id, name, "light", light),
  };
}

const ANSI_ORDER = [
  "black", "red", "green", "yellow", "blue", "magenta", "cyan", "white",
  "brightBlack", "brightRed", "brightGreen", "brightYellow", "brightBlue", "brightMagenta", "brightCyan", "brightWhite",
] as const;

/**
 * A terminal palette from sixteen colours in the usual order: the eight normal
 * colours, then the eight bright ones.
 */
export function ansi(colors: readonly [
  string, string, string, string, string, string, string, string,
  string, string, string, string, string, string, string, string,
]): AdeTerminalPalette {
  const out: AdeTerminalPalette = {};
  ANSI_ORDER.forEach((key, index) => {
    out[key] = colors[index]!;
  });
  return out;
}
