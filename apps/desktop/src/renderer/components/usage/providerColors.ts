import type { ThemeId } from "../../state/appStore";
import {
  PROVIDER_USAGE_COLORS,
  PROVIDER_USAGE_FALLBACK_PALETTE,
  type ProviderColorPair,
} from "../../../shared/providerColors";

/**
 * Brand-anchored provider colors for every usage bar, chip, and legend. The
 * table lives in shared code so desktop surfaces and the iOS mirror cannot
 * silently grow different brand values.
 *
 * Accounts deliberately have NO colour of their own. Hashing an account id into
 * a palette is what put a Claude account's bar in Gemini's blue, so every row
 * of a provider is drawn in that provider's colour and the email tells the
 * accounts apart.
 *
 * Anthropic/Claude keeps its rust family; the rest are picked to stay distinct
 * from one another without leaning on the generic blue/purple defaults.
 */
export type { ProviderColorPair } from "../../../shared/providerColors";

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
  const pair = PROVIDER_USAGE_COLORS[key]
    ?? PROVIDER_USAGE_FALLBACK_PALETTE[hashIndex(key, PROVIDER_USAGE_FALLBACK_PALETTE.length)]!;
  return theme === "light" ? pair.light : pair.dark;
}
