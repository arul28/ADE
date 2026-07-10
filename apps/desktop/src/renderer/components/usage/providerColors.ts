import type { ThemeId } from "../../state/appStore";

/**
 * Brand-anchored provider colors for usage bars and legends. One token map used
 * by every provider surface (the activity module and the Settings dashboard) so
 * a provider reads as the same color everywhere. Each provider carries a
 * light-theme and dark-theme value tuned to sit legibly on a card background.
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
 * accent. Theme-aware pairs, indexed by a hash of the provider name.
 */
const FALLBACK_PALETTE: ProviderColorPair[] = [
  { light: "#2563EB", dark: "#60A5FA" },
  { light: "#0F766E", dark: "#2DD4BF" },
  { light: "#B45309", dark: "#E0A82E" },
  { light: "#7C5CE0", dark: "#A78BFA" },
  { light: "#BE185D", dark: "#F472B6" },
  { light: "#4D7C0F", dark: "#A3E635" },
];

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
  const pair = PROVIDER_COLORS[key] ?? FALLBACK_PALETTE[hashIndex(key, FALLBACK_PALETTE.length)]!;
  return theme === "light" ? pair.light : pair.dark;
}

/** True when the provider has an explicit brand token (vs. a hashed fallback). */
export function hasProviderBrandColor(provider: string): boolean {
  return normalizeProvider(provider) in PROVIDER_COLORS;
}
