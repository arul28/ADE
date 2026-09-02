import type {
  AgentChatModelCatalog,
  ModelCatalogEntry,
  ProviderStatus,
  ProviderStatusRpcResult,
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
  checkedAt: string = new Date().toISOString(),
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
      // The honest derivation of "installed" from a catalog: ADE lists models
      // for a provider it can reach. It is a different question from "a binary
      // exists on disk", which is why `source: "derived"` travels with it and
      // why a UI should say "not detected" rather than "not installed".
      //
      // `@ade-dev/chat-ui` mirrors this rule in `src/adapters/sdkClient.ts`
      // because it takes this package only as an optional peer and must derive
      // the same answer for a client that is not this SDK. Keep both in step.
      installed: models.length > 0,
      binaryPath: null,
      version: null,
      authenticated: models.some((model) => model.connected === true),
      authMethod: null,
      installCommand: null,
      loginCommand: null,
      docsUrl: null,
      available: usable.length > 0,
      requiresConfiguration:
        usable.length > 0 && usable.every((model) => model.requiresConfiguration === true),
      modelCount: models.length,
      stale: catalogStale || models.some((model) => model.stale === true),
      source: "derived",
      checkedAt,
    };
  }
  return result;
}

function readBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function readNullableString(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

/**
 * Combines the probe with the catalog derivation.
 *
 * The two answer different questions and neither subsumes the other: the probe
 * knows what is on disk and whether a credential exists, and only the catalog
 * knows how many models are selectable and whether they need setup. So the
 * probe wins for the fields it measured, the catalog fills the rest, and a
 * provider the probe did not mention keeps its derived record — with
 * `source: "derived"` on it, so a caller can still tell the two apart inside
 * one map.
 */
export function mergeProviderStatus(
  probed: ProviderStatusRpcResult | null,
  derived: Record<string, ProviderStatus>,
): Record<string, ProviderStatus> {
  if (!probed || !probed.providers || typeof probed.providers !== "object") return derived;
  const merged: Record<string, ProviderStatus> = { ...derived };
  const probedAt = typeof probed.checkedAt === "string" ? probed.checkedAt : new Date().toISOString();
  for (const [key, entry] of Object.entries(probed.providers)) {
    if (!entry || typeof entry !== "object") continue;
    const catalog = derived[key];
    merged[key] = {
      provider: typeof entry.provider === "string" && entry.provider ? entry.provider : key,
      displayName:
        typeof entry.displayName === "string" && entry.displayName
          ? entry.displayName
          : (catalog?.displayName ?? key),
      installed: readBoolean(entry.installed, false),
      binaryPath: readNullableString(entry.binaryPath),
      version: readNullableString(entry.version),
      authenticated: readBoolean(entry.authenticated, false),
      authMethod: readNullableString(entry.authMethod),
      installCommand: readNullableString(entry.installCommand),
      loginCommand: readNullableString(entry.loginCommand),
      docsUrl: readNullableString(entry.docsUrl),
      available: catalog?.available ?? false,
      requiresConfiguration: catalog?.requiresConfiguration ?? false,
      modelCount: catalog?.modelCount ?? 0,
      // Either half being cached makes the record cached. Reporting fresh
      // because the other half was fresh would hide the caveat the field exists
      // to carry.
      stale: readBoolean(entry.stale, false) || catalog?.stale === true,
      source: "probed",
      checkedAt: typeof entry.checkedAt === "string" && entry.checkedAt ? entry.checkedAt : probedAt,
      ...(entry.detail !== undefined ? { detail: readNullableString(entry.detail) } : {}),
    };
  }
  return merged;
}

/**
 * Stable comparison so `providers.onChange` only fires on a real difference.
 *
 * Covers the probe fields as well as the derived ones: a CLI the user installed
 * or logged into while the app was open is exactly the change a setup screen
 * subscribes for, and it moves none of the four catalog fields.
 */
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
        entry.installed ? 1 : 0,
        entry.version ?? "",
        entry.binaryPath ?? "",
        entry.source,
      ].join(":");
    })
    .join("|");
}
