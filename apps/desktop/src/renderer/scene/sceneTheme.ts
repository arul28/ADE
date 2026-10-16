/**
 * A theme recoloured by a scene picture.
 *
 * The picture's leading colour becomes the accent (at a lightness that reads
 * on the theme's own background), and the background, surfaces and cards take
 * a faint wash of the picture's deep tone so the whole window feels like it
 * belongs to the picture. Everything else — text, borders, status colours,
 * corners, fonts — stays the theme's. The accent's foreground, bright and deep
 * shades and its muted tint are left to the resolver, which derives them from
 * the new accent exactly as it does for any custom theme.
 */

import { resolveTheme, type AdeTheme, type AdeThemePalette } from "../../shared/theme";
import { fromHsl, toHsl, type Rgb, type ScenePalette } from "./scenePalette";

function hex([r, g, b]: Rgb): string {
  const part = (value: number) => Math.round(Math.max(0, Math.min(255, value))).toString(16).padStart(2, "0");
  return `#${part(r)}${part(g)}${part(b)}`;
}

function parseHex(value: string): Rgb | null {
  const match = /^#([0-9a-f]{6})$/i.exec(value.trim());
  if (!match) return null;
  const n = Number.parseInt(match[1]!, 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

function mixHex(base: string, tint: Rgb, amount: number): string {
  const from = parseHex(base);
  if (!from) return base;
  return hex([
    from[0] + (tint[0] - from[0]) * amount,
    from[1] + (tint[1] - from[1]) * amount,
    from[2] + (tint[2] - from[2]) * amount,
  ]);
}

/** Palette keys that follow the accent; dropped so the resolver derives them again. */
const ACCENT_DERIVED: (keyof AdeThemePalette)[] = ["accentFg", "accentBright", "accentDeep", "accentMuted", "separatorActive"];

export function themeTintedByScene(theme: AdeTheme, scene: ScenePalette): AdeTheme {
  const resolved = resolveTheme(theme).palette;
  const isDark = theme.baseMode === "dark";
  // ramp[3] is the picture's leading colour at accent strength; its hue and
  // saturation carry over, the lightness is set for this theme's background.
  const [hue, saturation] = toHsl(scene.ramp[3]!);
  const accent = fromHsl(hue, Math.min(0.85, Math.max(0.45, saturation)), isDark ? 0.66 : 0.42);
  const wash = scene.ramp[1]!;

  const palette: AdeThemePalette = { ...resolved };
  for (const key of ACCENT_DERIVED) delete palette[key];
  palette.accent = hex(accent);
  const surfaceAmount = isDark ? 0.07 : 0.035;
  for (const key of ["bg", "canvas", "surface", "surfaceRaised", "surfaceRecessed", "card", "popover", "modal", "composer"] as const) {
    const value = resolved[key];
    if (value) palette[key] = mixHex(value, wash, key === "bg" || key === "canvas" ? surfaceAmount * 0.8 : surfaceAmount);
  }
  return {
    ...theme,
    source: "custom",
    palette,
    // The scene owns the backdrop now; a theme's grid or scanlines would sit on top of the picture.
    flair: theme.flair ? { ...theme.flair, backdrop: "none" } : theme.flair,
  };
}
