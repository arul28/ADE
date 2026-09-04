import type { ThemeId } from "../../state/appStore";
import { readThemeColor } from "../../lib/usePluginThemeRevision";

/**
 * Brand-anchored provider colors for usage bars and legends in the Settings
 * dashboard. Each provider carries a light-theme and dark-theme value tuned to
 * sit legibly on a card background.
 *
 * Anthropic/Claude keeps its rust family; the rest are picked to stay distinct
 * from one another without leaning on the generic blue/purple defaults.
 */
export type ProviderColorPair = { light: string; dark: string };

const PROVIDER_COLORS: Record<string, ProviderColorPair> = {
  claude: { light: "#C15F3C", dark: "#D97757" },
  anthropic: { light: "#C15F3C", dark: "#D97757" },
  codex: { light: "#0F9E8E", dark: "#2DD4BF" },
  openai: { light: "#0F9E8E", dark: "#2DD4BF" },
  cursor: { light: "#52627A", dark: "#93A6C4" },
  "cursor-agent": { light: "#52627A", dark: "#93A6C4" },
  copilot: { light: "#2DA44E", dark: "#3FB950" },
  gemini: { light: "#2C6FE0", dark: "#5B93F5" },
  google: { light: "#2C6FE0", dark: "#5B93F5" },
  droid: { light: "#B45309", dark: "#E0A82E" },
  opencode: { light: "#7C5CE0", dark: "#A78BFA" },
  deepseek: { light: "#3A54D6", dark: "#6C86FF" },
  mistral: { light: "#E05A00", dark: "#FF7A1A" },
  ollama: { light: "#6B7280", dark: "#A1A1AA" },
  lmstudio: { light: "#6D28D9", dark: "#9F7BEA" },
  openrouter: { light: "#0284C7", dark: "#38BDF8" },
  openclaw: { light: "#B45309", dark: "#E0A82E" },
  xai: { light: "#3F3F46", dark: "#B4B4BD" },
};

/**
 * Deterministic fallback palette for providers without a brand token, so an
 * unknown provider still gets a stable, distinct color instead of the default
 * accent. Indexed by a hash of the provider name.
 *
 * This is the app's data-series palette, `--color-chart-1..6` — the pairs below
 * are exactly the tokens' defaults in `index.css`, so the shipped themes look
 * identical and a plugin theme can now recolour an unknown provider.
 *
 * The token is resolved to a literal here rather than returned as a `var()`
 * string, because `providerColor()` feeds SVG presentation attributes:
 * `UsageDailyChart.tsx` writes `fill={seriesColor(...)}` and
 * `stroke={seriesColor(...)}`. A presentation attribute is not a CSS
 * declaration, so `var()` never substitutes there — the bar would render with
 * no fill at all. Returning a resolved literal works in every consumer, the
 * inline-`style` ones included.
 */
const FALLBACK_PALETTE: ProviderColorPair[] = [
  { light: "#2563EB", dark: "#60A5FA" },
  { light: "#0F766E", dark: "#2DD4BF" },
  { light: "#B45309", dark: "#E0A82E" },
  { light: "#7C5CE0", dark: "#A78BFA" },
  { light: "#BE185D", dark: "#F472B6" },
  { light: "#4D7C0F", dark: "#A3E635" },
];

/**
 * Reads one series colour, 1-based to match the token names.
 *
 * Read on every call rather than cached: the value has to be correct the first
 * time a chart renders after a plugin theme swaps the stylesheet, and this
 * module has no React context to hang an invalidation on. A caller that wants
 * the surrounding component to re-render on that swap adds
 * `usePluginThemeRevision()` to its own memo dependencies; the read itself is
 * one `getComputedStyle` lookup on the root element and runs a handful of times
 * per chart, not per data point.
 */
export function chartSeriesColor(index: number, theme: ThemeId = "dark"): string {
  const pair = FALLBACK_PALETTE[index % FALLBACK_PALETTE.length]!;
  return readThemeColor(`--color-chart-${(index % FALLBACK_PALETTE.length) + 1}`, theme === "light" ? pair.light : pair.dark);
}

function hashIndex(value: string, modulo: number): number {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
  }
  return hash % modulo;
}

function normalizeProvider(provider: string): string {
  return provider.trim().toLowerCase();
}

/** Returns the theme-appropriate brand color for a provider. */
export function providerColor(provider: string, theme: ThemeId = "dark"): string {
  const key = normalizeProvider(provider);
  // `PROVIDER_COLORS` stays hardcoded on purpose: those are brand identities —
  // Claude's rust, Copilot's green — not theme colours, and a theme that
  // repainted them would be misrepresenting the vendor, not restyling the app.
  const brand = PROVIDER_COLORS[key];
  if (brand) return theme === "light" ? brand.light : brand.dark;
  return chartSeriesColor(hashIndex(key, FALLBACK_PALETTE.length), theme);
}
