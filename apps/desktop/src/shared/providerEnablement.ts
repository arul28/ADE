/**
 * Which providers the user has switched off.
 *
 * Settings → Agents & Models gives every provider a toggle. Turning one off is
 * a statement about the whole app, not about one picker, so the answer lives
 * here and every surface that offers models asks the same question:
 *
 * - `getAvailableModels` drops the provider's rows,
 * - the catalog ADE publishes to the phone and the relay drops them too,
 * - the settings tile says "Disabled" and keeps its page reachable, because a
 *   switch you cannot find again is a one-way door.
 *
 * Entries are plain strings on purpose (see `AiConfig.disabledProviders`): the
 * list crosses the sync wire and an older build must round-trip ids it does not
 * know rather than silently dropping them.
 */

import type { AiConfig } from "./types/config";
import { MODEL_PROVIDER_GROUPS, type ModelProviderGroup } from "./modelRegistry";

/** Providers whose enablement Settings owns. Same set, same order, as the grid. */
export const TOGGLEABLE_PROVIDERS = MODEL_PROVIDER_GROUPS;

function normalize(id: string): string {
  return id.trim().toLowerCase();
}

/** The disabled set, normalised. Unknown ids are kept: they belong to a newer build. */
export function disabledProviderSet(
  ai: Pick<AiConfig, "disabledProviders"> | null | undefined,
): ReadonlySet<string> {
  const entries = ai?.disabledProviders ?? [];
  return new Set(entries.map(normalize).filter((id) => id.length > 0));
}

export function isProviderDisabled(
  ai: Pick<AiConfig, "disabledProviders"> | null | undefined,
  provider: string | null | undefined,
): boolean {
  if (!provider) return false;
  const disabled = ai?.disabledProviders;
  if (!disabled?.length) return false;
  return disabledProviderSet(ai).has(normalize(provider));
}

/**
 * The next `disabledProviders` list after flipping one provider.
 *
 * Returns the whole authoritative list because that is what the config write
 * path expects: `mergeAiConfig` replaces this field rather than unioning it, so
 * a patch carrying only the delta would never be able to re-enable anything.
 */
export function toggleDisabledProvider(
  ai: Pick<AiConfig, "disabledProviders"> | null | undefined,
  provider: string,
  disabled: boolean,
): string[] {
  const next = new Set(disabledProviderSet(ai));
  if (disabled) next.add(normalize(provider));
  else next.delete(normalize(provider));
  return [...next];
}

/** Filter a provider-keyed list down to the providers still switched on. */
export function enabledProviderGroups(
  ai: Pick<AiConfig, "disabledProviders"> | null | undefined,
  groups: readonly ModelProviderGroup[] = TOGGLEABLE_PROVIDERS,
): ModelProviderGroup[] {
  const disabled = disabledProviderSet(ai);
  return groups.filter((group) => !disabled.has(group));
}
