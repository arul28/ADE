import type {
  AgentChatModelCatalog,
  ModelCatalogEntry,
  ProviderStatus,
} from "./types.js";

/** Flattens the nested catalog into the row shape the SDK exposes. */
export function flattenCatalog(catalog: AgentChatModelCatalog | null): ModelCatalogEntry[] {
  const rows: ModelCatalogEntry[] = [];
  for (const group of catalog?.groups ?? []) {
    for (const provider of group.providers ?? []) {
      for (const subsection of provider.subsections ?? []) {
        for (const model of subsection.models ?? []) {
          rows.push({
            id: model.id,
            displayName: model.displayName,
            provider: String(model.groupKey ?? model.provider ?? group.key),
            runtimeModelId: model.runtimeModelId,
            isDefault: model.isDefault === true,
            isAvailable: model.isAvailable !== false,
            connected: model.connected === true,
            requiresConfiguration: model.requiresConfiguration === true,
            reasoningEfforts: (model.reasoningEfforts ?? []).map((entry) => entry.effort),
            defaultReasoningEffort: model.defaultReasoningEffort ?? null,
            description: model.description ?? null,
          });
        }
      }
    }
  }
  return rows;
}

/**
 * Rolls the catalog up to one row per provider.
 *
 * DERIVED — see `ProviderStatus` in types.ts. The machine scope publishes no
 * provider-auth RPC, so "authenticated" means "the catalog resolved at least
 * one connected model for this provider". That is the same signal ADE's own
 * model picker uses to decide whether a provider is usable, but it is weaker
 * than a real auth probe: a provider whose catalog is served from cache can
 * report connected while its credential has since expired. `stale` carries that
 * caveat to the caller instead of hiding it.
 */
export function deriveProviderStatus(
  catalog: AgentChatModelCatalog | null,
): Record<string, ProviderStatus> {
  const result: Record<string, ProviderStatus> = {};
  const catalogStale = catalog?.stale === true;
  for (const group of catalog?.groups ?? []) {
    const models = (group.providers ?? []).flatMap((provider) =>
      (provider.subsections ?? []).flatMap((subsection) => subsection.models ?? []),
    );
    const usable = models.filter((model) => model.isAvailable !== false);
    result[group.key] = {
      provider: group.key,
      displayName: group.displayName,
      authenticated: models.some((model) => model.connected === true),
      available: usable.length > 0,
      requiresConfiguration:
        usable.length > 0 && usable.every((model) => model.requiresConfiguration === true),
      modelCount: models.length,
      stale: catalogStale || models.some((model) => model.stale === true),
    };
  }
  return result;
}

/** Stable comparison so `providers.onChange` only fires on a real difference. */
export function providerStatusFingerprint(status: Record<string, ProviderStatus>): string {
  return Object.keys(status)
    .sort()
    .map((key) => {
      const entry = status[key]!;
      return [
        key,
        entry.authenticated ? 1 : 0,
        entry.available ? 1 : 0,
        entry.requiresConfiguration ? 1 : 0,
        entry.modelCount,
      ].join(":");
    })
    .join("|");
}
