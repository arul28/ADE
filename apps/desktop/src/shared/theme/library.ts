/**
 * The themes ADE ships with.
 *
 * `dark` and `light` are the two the stylesheet already defines; their palettes
 * here exist for previews and for the customizer to start from, and the engine
 * deliberately emits no runtime overrides for them. The rest are ADE-authored
 * themes the engine paints from their palettes the same way it paints a user's
 * custom theme — there is no second code path for "official" extras.
 *
 * The list is ordered the way the gallery shows it: the two defaults first,
 * then the curated extras.
 */

import type { AdeTheme } from "./types";

export const DEFAULT_THEME_ID = "dark";
export const FALLBACK_THEME_ID = "dark";

export const ADE_BUILTIN_THEMES: readonly AdeTheme[] = [
  {
    formatVersion: 1,
    id: "dark",
    name: "ADE Dark",
    description: "Dark surfaces with a cool violet accent. The default.",
    baseMode: "dark",
    source: "builtin",
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
    formatVersion: 1,
    id: "light",
    name: "ADE Light",
    description: "Warm light background with a saturated green accent.",
    baseMode: "light",
    source: "builtin",
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
  {
    formatVersion: 1,
    id: "obsidian",
    name: "Obsidian",
    description: "True black for OLED panels, with a soft violet accent.",
    baseMode: "dark",
    source: "builtin",
    basedOn: "dark",
    palette: {
      bg: "#000000",
      canvas: "#050506",
      fg: "#EDEDF0",
      surface: "#0B0B0F",
      surfaceRaised: "#131318",
      surfaceRecessed: "#000000",
      card: "#101014",
      secondary: "#17171C",
      muted: "#121216",
      mutedFg: "#9A9AA6",
      border: "#242430",
      popover: "#0D0D11",
      modal: "#101014",
      composer: "#0B0B0F",
      accent: "#A78BFA",
      accentBright: "#C4B5FD",
      accentDeep: "#7C3AED",
    },
  },
  {
    formatVersion: 1,
    id: "high-contrast",
    name: "High Contrast",
    description: "Maximum legibility for accessibility, AA text everywhere.",
    baseMode: "dark",
    source: "builtin",
    basedOn: "dark",
    palette: {
      bg: "#000000",
      canvas: "#000000",
      fg: "#FFFFFF",
      surface: "#0A0A0A",
      surfaceRaised: "#161616",
      surfaceRecessed: "#000000",
      card: "#111111",
      cardFg: "#FFFFFF",
      secondary: "#1C1C1C",
      secondaryFg: "#E6E6E6",
      muted: "#141414",
      mutedFg: "#C8C8C8",
      border: "#5A5A5A",
      separator: "#5A5A5A",
      popover: "#0A0A0A",
      modal: "#111111",
      composer: "#0A0A0A",
      accent: "#FFD24A",
      accentFg: "#000000",
      accentBright: "#FFE08A",
      accentDeep: "#D6A100",
      success: "#4ADE80",
      warning: "#FBBF24",
      error: "#F87171",
      info: "#60A5FA",
    },
  },
  {
    formatVersion: 1,
    id: "midnight",
    name: "Midnight",
    description: "Deep navy blues with a bright sky accent.",
    baseMode: "dark",
    source: "builtin",
    basedOn: "dark",
    palette: {
      bg: "#0B1220",
      canvas: "#0A101C",
      fg: "#E6EDF7",
      surface: "#111A2E",
      surfaceRaised: "#17223A",
      surfaceRecessed: "#080D18",
      card: "#14203A",
      secondary: "#1B2946",
      muted: "#152037",
      mutedFg: "#8FA3C4",
      border: "#233457",
      popover: "#101A2E",
      modal: "#14203A",
      composer: "#0F1830",
      accent: "#60A5FA",
      accentFg: "#07101F",
      accentBright: "#93C5FD",
      accentDeep: "#2563EB",
    },
  },
  {
    formatVersion: 1,
    id: "evergreen",
    name: "Evergreen",
    description: "Forest greens with an emerald accent.",
    baseMode: "dark",
    source: "builtin",
    basedOn: "dark",
    palette: {
      bg: "#0C1512",
      canvas: "#0A1210",
      fg: "#E3EFE9",
      surface: "#12201B",
      surfaceRaised: "#182B24",
      surfaceRecessed: "#08100D",
      card: "#16271F",
      secondary: "#1D3329",
      muted: "#152820",
      mutedFg: "#8DB3A2",
      border: "#26443A",
      popover: "#101E19",
      modal: "#16271F",
      composer: "#0F1C17",
      accent: "#34D399",
      accentFg: "#04140E",
      accentBright: "#6EE7B7",
      accentDeep: "#059669",
    },
  },
  {
    formatVersion: 1,
    id: "parchment",
    name: "Parchment",
    description: "Warm paper light theme with an amber accent.",
    baseMode: "light",
    source: "builtin",
    basedOn: "light",
    palette: {
      bg: "#FBF6EE",
      canvas: "#FBF6EE",
      fg: "#3A3226",
      surface: "#F5EDE1",
      surfaceRaised: "#FFFDF8",
      surfaceRecessed: "#EDE3D2",
      card: "#FFFDF8",
      secondary: "#EDE3D3",
      secondaryFg: "#6B5F4B",
      muted: "#F0E8DB",
      mutedFg: "#6E6250",
      border: "#DCCFB8",
      separator: "#E7DCC9",
      popover: "#FFFDF8",
      modal: "#FFFDF8",
      composer: "#FFFDF8",
      accent: "#B45309",
      accentFg: "#FFFDF8",
      accentBright: "#D97706",
      accentDeep: "#92400E",
    },
  },
  {
    formatVersion: 1,
    id: "blush",
    name: "Blush",
    description: "Soft rose light theme with a magenta accent.",
    baseMode: "light",
    source: "builtin",
    basedOn: "light",
    palette: {
      bg: "#FBF1F3",
      canvas: "#FBF1F3",
      fg: "#3D2830",
      surface: "#F7E7EB",
      surfaceRaised: "#FFF8FA",
      surfaceRecessed: "#F0DCE1",
      card: "#FFF8FA",
      secondary: "#F1DDE2",
      secondaryFg: "#6E4E58",
      muted: "#F4E2E7",
      mutedFg: "#735560",
      border: "#E3C7CF",
      separator: "#EDD6DC",
      popover: "#FFF8FA",
      modal: "#FFF8FA",
      composer: "#FFF8FA",
      accent: "#BE185D",
      accentFg: "#FFF8FA",
      accentBright: "#DB2777",
      accentDeep: "#9D174D",
    },
  },
] as const;

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
  return (
    BUILTIN_THEME_MAP.get(id)
    ?? (customThemes ?? []).find((theme) => theme.id === id)
    ?? BUILTIN_THEME_MAP.get(FALLBACK_THEME_ID)!
  );
}

/** The base mode an id paints in; used to keep `data-theme` and `theme` in step. */
export function baseModeForThemeId(id: string, customThemes: readonly AdeTheme[] | undefined): "dark" | "light" {
  return resolveThemeById(id, customThemes).baseMode;
}
