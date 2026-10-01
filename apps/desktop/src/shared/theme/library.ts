/**
 * The themes ADE ships with.
 *
 * Every shipped theme belongs to a family, and every family has a dark and a
 * light variant, so the colour scheme (dark, light, or follow the system) and
 * the theme are two separate choices. `dark` and `light` are the ADE family:
 * the stylesheet already defines them, their palettes here exist for previews
 * and for the customizer to start from, and the engine emits no runtime
 * overrides for them. The other families are painted from their palettes the
 * same way the engine paints a user's custom theme.
 *
 * A family changes the surfaces, the borders and the status tones, not only the
 * accent; a theme that only moved the accent would read as dark or light with a
 * different button colour.
 */

import { family, type AdeThemeFamily } from "./family";
import { CLASSIC_FAMILIES } from "./libraryClassics";
import { ORIGINAL_FAMILIES } from "./libraryOriginals";
import type { AdeTheme, ThemeBaseMode } from "./types";

export { THEME_COLLECTIONS, type AdeThemeFamily, type ThemeCollection } from "./family";

export const DEFAULT_THEME_ID = "dark";
export const FALLBACK_THEME_ID = "dark";

const ADE_CORE_FAMILIES: readonly AdeThemeFamily[] = [
  family(
    "ade",
    "ADE",
    {
      id: "dark",
      description: "Violet on deep ink. The default.",
      palette: {
        bg: "#0C0B10",
        canvas: "#0f0f11",
        fg: "#F0F0F2",
        surface: "#16141E",
        surfaceRaised: "#1E1B2E",
        surfaceRecessed: "#0A090E",
        surfaceOverlay: "#1E1B2E",
        card: "#1A1830",
        cardFg: "#F0F0F2",
        secondary: "#252232",
        secondaryFg: "#A8A8B4",
        muted: "#1E1B28",
        mutedFg: "#908FA0",
        border: "#302C42",
        separator: "#302C42",
        separatorActive: "#A78BFA",
        popover: "#151325",
        modal: "#1A1830",
        composer: "#14121F",
        accent: "#A78BFA",
        accentFg: "#0C0B10",
        accentBright: "#C4B5FD",
        accentDeep: "#7C3AED",
        accentMuted: "rgba(167, 139, 250, 0.20)",
        success: "#22c55e",
        warning: "#f59e0b",
        error: "#ef4444",
        info: "#3b82f6",
      },
    },
    {
      id: "light",
      description: "Warm stone with a green accent.",
      palette: {
        bg: "#f5f3f0",
        canvas: "#f5f3f0",
        fg: "#1a1a1e",
        surface: "#faf8f5",
        surfaceRaised: "#ffffff",
        surfaceRecessed: "#eae7e2",
        surfaceOverlay: "rgba(255, 255, 255, 0.92)",
        card: "#ffffff",
        cardFg: "#1a1a1e",
        secondary: "#e8e5e0",
        secondaryFg: "#52525b",
        muted: "#ece9e4",
        mutedFg: "#636370",
        border: "#d6d3ce",
        separator: "#e8e5e0",
        separatorActive: "#049068",
        popover: "#ffffff",
        modal: "#ffffff",
        composer: "#ffffff",
        accent: "#049068",
        accentFg: "#ffffff",
        accentBright: "#4FC49B",
        accentDeep: "#0E9A72",
        accentMuted: "rgba(4, 144, 104, 0.10)",
        success: "#16a34a",
        warning: "#d97706",
        error: "#dc2626",
        info: "#2563eb",
      },
    },
  ),
  family(
    "graphite",
    "Graphite",
    {
      description: "Neutral greys with an electric blue accent.",
      palette: {
        bg: "#0E0E10",
        canvas: "#111113",
        fg: "#EDEDEF",
        surface: "#161618",
        surfaceRaised: "#1D1D20",
        surfaceRecessed: "#0A0A0B",
        card: "#19191C",
        secondary: "#232326",
        secondaryFg: "#A1A1AA",
        muted: "#1B1B1E",
        mutedFg: "#8E8E96",
        border: "#2A2A2F",
        popover: "#18181B",
        modal: "#19191C",
        composer: "#141416",
        accent: "#5B8CFF",
        accentFg: "#07101F",
        accentBright: "#8AADFF",
        accentDeep: "#3563E9",
      },
    },
    {
      description: "Clean white with an electric blue accent.",
      palette: {
        bg: "#F7F7F8",
        canvas: "#F7F7F8",
        fg: "#18181B",
        surface: "#F1F1F3",
        surfaceRaised: "#FFFFFF",
        surfaceRecessed: "#E9E9EC",
        card: "#FFFFFF",
        secondary: "#E7E7EA",
        secondaryFg: "#52525B",
        muted: "#EEEEF0",
        mutedFg: "#62626C",
        border: "#DCDCE0",
        separator: "#E6E6E9",
        popover: "#FFFFFF",
        modal: "#FFFFFF",
        composer: "#FFFFFF",
        accent: "#2F6BEF",
        accentFg: "#FFFFFF",
        accentBright: "#5B8CFF",
        accentDeep: "#1F4FC4",
      },
    },
  ),
  family(
    "mono",
    "Mono",
    {
      description: "True black and white. Made for OLED.",
      palette: {
        bg: "#000000",
        canvas: "#000000",
        fg: "#F5F5F5",
        surface: "#0A0A0A",
        surfaceRaised: "#141414",
        surfaceRecessed: "#000000",
        card: "#0F0F0F",
        secondary: "#1A1A1A",
        secondaryFg: "#B4B4B4",
        muted: "#121212",
        mutedFg: "#A0A0A0",
        border: "#262626",
        separator: "#262626",
        popover: "#0C0C0C",
        modal: "#0F0F0F",
        composer: "#0A0A0A",
        accent: "#FAFAFA",
        accentFg: "#000000",
        accentBright: "#FFFFFF",
        accentDeep: "#D4D4D4",
        accentMuted: "rgba(250, 250, 250, 0.12)",
        success: "#4ADE80",
        warning: "#FBBF24",
        error: "#F87171",
        info: "#60A5FA",
      },
    },
    {
      description: "Ink on white paper.",
      palette: {
        bg: "#FFFFFF",
        canvas: "#FFFFFF",
        fg: "#0A0A0A",
        surface: "#FAFAFA",
        surfaceRaised: "#FFFFFF",
        surfaceRecessed: "#F2F2F2",
        card: "#FFFFFF",
        secondary: "#EFEFEF",
        secondaryFg: "#4A4A4A",
        muted: "#F4F4F4",
        mutedFg: "#5E5E5E",
        border: "#E2E2E2",
        separator: "#ECECEC",
        popover: "#FFFFFF",
        modal: "#FFFFFF",
        composer: "#FFFFFF",
        accent: "#0A0A0A",
        accentFg: "#FFFFFF",
        accentBright: "#3A3A3A",
        accentDeep: "#000000",
        accentMuted: "rgba(10, 10, 10, 0.07)",
      },
    },
  ),
  family(
    "ocean",
    "Ocean",
    {
      description: "Deep sea teal with an aqua accent.",
      palette: {
        bg: "#071519",
        canvas: "#081A1F",
        fg: "#DDF1F2",
        surface: "#0C2026",
        surfaceRaised: "#112A31",
        surfaceRecessed: "#051014",
        card: "#0F252C",
        secondary: "#153139",
        secondaryFg: "#9BC0C4",
        muted: "#0F262D",
        mutedFg: "#7FA6AC",
        border: "#1D3C44",
        popover: "#0D2228",
        modal: "#0F252C",
        composer: "#0B1E23",
        accent: "#2DD4BF",
        accentFg: "#032019",
        accentBright: "#5EEAD4",
        accentDeep: "#0F9C8A",
        info: "#38BDF8",
      },
    },
    {
      description: "Sea glass with a teal accent.",
      palette: {
        bg: "#F0F7F7",
        canvas: "#F0F7F7",
        fg: "#0F2A2E",
        surface: "#E6F1F1",
        surfaceRaised: "#FAFDFD",
        surfaceRecessed: "#DAE9E9",
        card: "#FAFDFD",
        secondary: "#D8E8E8",
        secondaryFg: "#3F5E62",
        muted: "#E1EEEE",
        mutedFg: "#4C6B6F",
        border: "#C3D9DA",
        separator: "#D3E4E5",
        popover: "#FAFDFD",
        modal: "#FAFDFD",
        composer: "#FAFDFD",
        accent: "#0D8577",
        accentFg: "#FFFFFF",
        accentBright: "#14B8A6",
        accentDeep: "#0B6B60",
        info: "#0369A1",
      },
    },
  ),
  family(
    "glacier",
    "Glacier",
    {
      description: "Arctic slate with a frost accent.",
      palette: {
        bg: "#1E222A",
        canvas: "#20242C",
        fg: "#E5E9F0",
        surface: "#242933",
        surfaceRaised: "#2B303B",
        surfaceRecessed: "#1A1D24",
        card: "#272C36",
        secondary: "#313744",
        secondaryFg: "#B4BCCB",
        muted: "#2A2F3A",
        mutedFg: "#9AA3B5",
        border: "#3B4252",
        popover: "#262B35",
        modal: "#272C36",
        composer: "#222731",
        accent: "#88C0D0",
        accentFg: "#1A2027",
        accentBright: "#A3D4E0",
        accentDeep: "#5E9FB3",
        success: "#A3BE8C",
        warning: "#EBCB8B",
        error: "#BF616A",
        info: "#81A1C1",
        diffAdd: "#A3BE8C",
        diffDel: "#BF616A",
        diffHunk: "#81A1C1",
      },
    },
    {
      description: "Snow and slate with a fjord accent.",
      palette: {
        bg: "#ECEFF4",
        canvas: "#ECEFF4",
        fg: "#2E3440",
        surface: "#E5E9F0",
        surfaceRaised: "#F8F9FB",
        surfaceRecessed: "#D8DEE9",
        card: "#F8F9FB",
        secondary: "#DDE2EA",
        secondaryFg: "#4C566A",
        muted: "#E3E7EE",
        mutedFg: "#56607A",
        border: "#CBD2DE",
        separator: "#D8DEE9",
        popover: "#F8F9FB",
        modal: "#F8F9FB",
        composer: "#F8F9FB",
        accent: "#4C6F9C",
        accentFg: "#FFFFFF",
        accentBright: "#5E81AC",
        accentDeep: "#3B5A82",
        success: "#4F7A3A",
        warning: "#B7862A",
        error: "#B0474F",
        info: "#4C6F9C",
      },
    },
  ),
  family(
    "cobalt",
    "Cobalt",
    {
      description: "Saturated cobalt blue with a gold accent.",
      palette: {
        bg: "#0A1A33",
        canvas: "#0B1D38",
        fg: "#E8F0FF",
        surface: "#0F2446",
        surfaceRaised: "#142C54",
        surfaceRecessed: "#07142A",
        card: "#12284D",
        secondary: "#183260",
        secondaryFg: "#A9BCE0",
        muted: "#122A50",
        mutedFg: "#8FA7CF",
        border: "#1F3C6E",
        popover: "#11264A",
        modal: "#12284D",
        composer: "#0E2242",
        accent: "#FFC600",
        accentFg: "#1A1400",
        accentBright: "#FFD84D",
        accentDeep: "#E0A800",
        success: "#3AD900",
        warning: "#FF9D00",
        error: "#FF628C",
        info: "#4FB3FF",
      },
    },
    {
      description: "Pale sky with a cobalt accent.",
      palette: {
        bg: "#EEF3FC",
        canvas: "#EEF3FC",
        fg: "#0B1F44",
        surface: "#E3EBF9",
        surfaceRaised: "#FBFCFF",
        surfaceRecessed: "#D6E1F5",
        card: "#FBFCFF",
        secondary: "#D5E0F4",
        secondaryFg: "#37507F",
        muted: "#DFE8F8",
        mutedFg: "#445C8A",
        border: "#BFD0EE",
        separator: "#D2DEF3",
        popover: "#FBFCFF",
        modal: "#FBFCFF",
        composer: "#FBFCFF",
        accent: "#1D4ED8",
        accentFg: "#FFFFFF",
        accentBright: "#3B6EF0",
        accentDeep: "#1740B0",
      },
    },
  ),
  family(
    "grove",
    "Grove",
    {
      description: "Moss and pine with a leaf accent.",
      palette: {
        bg: "#0E1411",
        canvas: "#101713",
        fg: "#E4EDE6",
        surface: "#141C17",
        surfaceRaised: "#1A241E",
        surfaceRecessed: "#0A0F0C",
        card: "#17201A",
        secondary: "#1F2B23",
        secondaryFg: "#A7BBAC",
        muted: "#18221C",
        mutedFg: "#8FA597",
        border: "#26352C",
        popover: "#151E18",
        modal: "#17201A",
        composer: "#121A15",
        accent: "#7BD88F",
        accentFg: "#07170C",
        accentBright: "#A2E8B0",
        accentDeep: "#3FAF5C",
        warning: "#E5C07B",
      },
    },
    {
      description: "Sage paper with a forest accent.",
      palette: {
        bg: "#F3F5EE",
        canvas: "#F3F5EE",
        fg: "#1D2A20",
        surface: "#EAEEE3",
        surfaceRaised: "#FCFDF9",
        surfaceRecessed: "#DFE5D6",
        card: "#FCFDF9",
        secondary: "#DDE4D3",
        secondaryFg: "#4A5A4C",
        muted: "#E6EBDE",
        mutedFg: "#536655",
        border: "#CBD5BF",
        separator: "#DBE2D0",
        popover: "#FCFDF9",
        modal: "#FCFDF9",
        composer: "#FCFDF9",
        accent: "#2F7D46",
        accentFg: "#FFFFFF",
        accentBright: "#3F9A58",
        accentDeep: "#22603A",
      },
    },
  ),
  family(
    "dune",
    "Dune",
    {
      description: "Desert night with a gold accent.",
      palette: {
        bg: "#15120C",
        canvas: "#17140E",
        fg: "#F0E8D8",
        surface: "#1C1812",
        surfaceRaised: "#241F17",
        surfaceRecessed: "#0F0D09",
        card: "#201B14",
        secondary: "#2A241B",
        secondaryFg: "#C2B498",
        muted: "#221D15",
        mutedFg: "#A89A80",
        border: "#362E22",
        popover: "#1E1A13",
        modal: "#201B14",
        composer: "#1A1611",
        accent: "#E8B04B",
        accentFg: "#1A1206",
        accentBright: "#F2C874",
        accentDeep: "#C48F2A",
        success: "#A8C66C",
        info: "#7FB2D6",
      },
    },
    {
      description: "Parchment with an amber accent.",
      palette: {
        bg: "#FAF5EA",
        canvas: "#FAF5EA",
        fg: "#3A3020",
        surface: "#F3EBDB",
        surfaceRaised: "#FFFCF5",
        surfaceRecessed: "#EAE0CB",
        card: "#FFFCF5",
        secondary: "#EBE1CC",
        secondaryFg: "#6A5B40",
        muted: "#F0E7D5",
        mutedFg: "#6E5F45",
        border: "#DDCFB2",
        separator: "#E8DCC4",
        popover: "#FFFCF5",
        modal: "#FFFCF5",
        composer: "#FFFCF5",
        accent: "#A86A0C",
        accentFg: "#FFFCF5",
        accentBright: "#C98A1E",
        accentDeep: "#85520A",
        success: "#5E7F2A",
      },
    },
  ),
  family(
    "ember",
    "Ember",
    {
      description: "Charred wood with a flame accent.",
      palette: {
        bg: "#140E0C",
        canvas: "#17100D",
        fg: "#F2E6E0",
        surface: "#1C1411",
        surfaceRaised: "#251A16",
        surfaceRecessed: "#0E0908",
        card: "#201714",
        secondary: "#2B1F1A",
        secondaryFg: "#C4ACA2",
        muted: "#231914",
        mutedFg: "#AA948A",
        border: "#3A2A23",
        popover: "#1E1512",
        modal: "#201714",
        composer: "#1A1210",
        accent: "#FF7A45",
        accentFg: "#1C0A03",
        accentBright: "#FF9C72",
        accentDeep: "#E0551F",
        warning: "#FBBF24",
      },
    },
    {
      description: "Clay and cream with a burnt orange accent.",
      palette: {
        bg: "#FBF3EF",
        canvas: "#FBF3EF",
        fg: "#3A2019",
        surface: "#F5E8E2",
        surfaceRaised: "#FFFBF9",
        surfaceRecessed: "#EDDCD4",
        card: "#FFFBF9",
        secondary: "#EEDCD3",
        secondaryFg: "#6B4A3F",
        muted: "#F2E3DC",
        mutedFg: "#6F5046",
        border: "#E2C8BD",
        separator: "#EBD7CE",
        popover: "#FFFBF9",
        modal: "#FFFBF9",
        composer: "#FFFBF9",
        accent: "#C2410C",
        accentFg: "#FFFFFF",
        accentBright: "#EA580C",
        accentDeep: "#9A3412",
      },
    },
  ),
  family(
    "rose",
    "Rosé",
    {
      description: "Plum velvet with a pink accent.",
      palette: {
        bg: "#16101A",
        canvas: "#19121D",
        fg: "#F2E4EE",
        surface: "#1E1522",
        surfaceRaised: "#271C2C",
        surfaceRecessed: "#100B13",
        card: "#221826",
        secondary: "#2D2031",
        secondaryFg: "#C3AAB9",
        muted: "#251A29",
        mutedFg: "#A8919F",
        border: "#3A2A3F",
        popover: "#201724",
        modal: "#221826",
        composer: "#1C1420",
        accent: "#F472B6",
        accentFg: "#22061A",
        accentBright: "#F9A8D4",
        accentDeep: "#DB2777",
      },
    },
    {
      description: "Blush with a magenta accent.",
      palette: {
        bg: "#FCF2F5",
        canvas: "#FCF2F5",
        fg: "#3D2231",
        surface: "#F7E6EC",
        surfaceRaised: "#FFFAFC",
        surfaceRecessed: "#EFD9E1",
        card: "#FFFAFC",
        secondary: "#F0DAE2",
        secondaryFg: "#6E4A5A",
        muted: "#F4E1E8",
        mutedFg: "#74525F",
        border: "#E5C6D2",
        separator: "#EDD5DE",
        popover: "#FFFAFC",
        modal: "#FFFAFC",
        composer: "#FFFAFC",
        accent: "#BE185D",
        accentFg: "#FFFFFF",
        accentBright: "#DB2777",
        accentDeep: "#9D174D",
      },
    },
  ),
];

/** ADE's own families first (the default is the first), then the originals, then the classics. */
export const ADE_THEME_FAMILIES: readonly AdeThemeFamily[] = [
  ...ADE_CORE_FAMILIES,
  ...ORIGINAL_FAMILIES,
  ...CLASSIC_FAMILIES,
];

export const ADE_BUILTIN_THEMES: readonly AdeTheme[] = ADE_THEME_FAMILIES.flatMap((entry) => [entry.dark, entry.light]);

/**
 * Ids earlier builds shipped, mapped to the variant that replaced each one, so
 * a stored or synced choice keeps its look instead of falling back to ADE Dark.
 */
export const LEGACY_THEME_ID_ALIASES: Readonly<Record<string, string>> = {
  obsidian: "mono-dark",
  "high-contrast": "mono-dark",
  midnight: "cobalt-dark",
  evergreen: "grove-dark",
  parchment: "dune-light",
  blush: "rose-light",
};

/** The current id for `id`: the replacement for a retired shipped id, else `id`. */
export function canonicalThemeId(id: string): string {
  return LEGACY_THEME_ID_ALIASES[id] ?? id;
}

export const BUILTIN_THEME_IDS: readonly string[] = ADE_BUILTIN_THEMES.map((theme) => theme.id);

const BUILTIN_THEME_MAP: ReadonlyMap<string, AdeTheme> = new Map(
  ADE_BUILTIN_THEMES.map((theme) => [theme.id, theme]),
);

export function getShippedTheme(id: string): AdeTheme | undefined {
  return BUILTIN_THEME_MAP.get(id);
}

export function isShippedThemeId(id: string): boolean {
  return BUILTIN_THEME_MAP.has(id);
}

/** Every theme a user can pick: shipped first, then their own, de-duplicated by id. */
export function allThemeOptions(customThemes: readonly AdeTheme[] | undefined): AdeTheme[] {
  const out: AdeTheme[] = [...ADE_BUILTIN_THEMES];
  const seen = new Set(BUILTIN_THEME_IDS);
  for (const theme of customThemes ?? []) {
    if (seen.has(theme.id)) continue;
    seen.add(theme.id);
    out.push(theme);
  }
  return out;
}

/**
 * Resolve an id to a theme, falling back to the default when it names nothing
 * this machine knows. A custom theme id that has not arrived from sync yet
 * resolves to the fallback rather than throwing.
 */
export function resolveThemeById(id: string, customThemes: readonly AdeTheme[] | undefined): AdeTheme {
  const canonical = canonicalThemeId(id);
  return (
    BUILTIN_THEME_MAP.get(canonical)
    ?? (customThemes ?? []).find((theme) => theme.id === id)
    ?? BUILTIN_THEME_MAP.get(FALLBACK_THEME_ID)!
  );
}

/** The base mode an id paints in; used to keep `data-theme` and `theme` in step. */
export function baseModeForThemeId(id: string, customThemes: readonly AdeTheme[] | undefined): "dark" | "light" {
  return resolveThemeById(id, customThemes).baseMode;
}

const FAMILY_BY_THEME_ID: ReadonlyMap<string, AdeThemeFamily> = new Map(
  ADE_THEME_FAMILIES.flatMap((entry) => [[entry.dark.id, entry], [entry.light.id, entry]] as const),
);

/** The shipped family `id` belongs to, or undefined for a custom theme. */
export function themeFamilyForId(id: string): AdeThemeFamily | undefined {
  return FAMILY_BY_THEME_ID.get(canonicalThemeId(id));
}

/**
 * The id to paint for `id` in `mode`: the same family's other variant when
 * `id` is a shipped theme, else `id` unchanged. A custom theme has one mode.
 */
export function themeIdForMode(id: string, mode: ThemeBaseMode): string {
  const entry = themeFamilyForId(id);
  if (!entry) return id;
  return entry[mode].id;
}
