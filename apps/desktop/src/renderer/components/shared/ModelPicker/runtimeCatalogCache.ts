import type { AgentChatModelCatalog, AgentChatModelCatalogRefreshProvider } from "../../../../shared/types";

const RUNTIME_CATALOG_REFRESH_TTL_MS = 30 * 60_000;
const RUNTIME_CATALOG_LOCAL_REFRESH_TTL_MS = 30_000;
const REFRESH_PROVIDERS: AgentChatModelCatalogRefreshProvider[] = [
  "opencode",
  "cursor",
  "droid",
  "lmstudio",
  "ollama",
];

let sharedRuntimeCatalog: AgentChatModelCatalog | null = null;
const sharedRuntimeCatalogProviderRefreshedAt = new Map<AgentChatModelCatalogRefreshProvider, number>();
const sharedRuntimeCatalogRequests = new Map<string, Promise<AgentChatModelCatalog | null>>();

export function resetModelPickerRuntimeCatalogForTests(): void {
  sharedRuntimeCatalog = null;
  sharedRuntimeCatalogProviderRefreshedAt.clear();
  sharedRuntimeCatalogRequests.clear();
}

export function getSharedRuntimeCatalog(): AgentChatModelCatalog | null {
  return sharedRuntimeCatalog;
}

function runtimeCatalogRefreshTtlMs(provider?: AgentChatModelCatalogRefreshProvider): number {
  return provider === "lmstudio" || provider === "ollama"
    ? RUNTIME_CATALOG_LOCAL_REFRESH_TTL_MS
    : RUNTIME_CATALOG_REFRESH_TTL_MS;
}

function catalogContainsRefreshProvider(
  catalog: AgentChatModelCatalog,
  provider: AgentChatModelCatalogRefreshProvider,
): boolean {
  return (catalog.groups ?? []).some((group) => {
    const groupMatches = provider === "droid"
      ? group.key === "droid"
      : group.key === provider;
    if (!groupMatches) return false;
    return (group.providers ?? []).some((entry) => entry.modelCount > 0);
  });
}

function markRuntimeCatalogProviderFresh(
  provider: AgentChatModelCatalogRefreshProvider,
  refreshedAt = Date.now(),
): void {
  sharedRuntimeCatalogProviderRefreshedAt.set(provider, refreshedAt);
}

export function runtimeCatalogProviderIsFresh(provider: AgentChatModelCatalogRefreshProvider): boolean {
  const refreshedAt = sharedRuntimeCatalogProviderRefreshedAt.get(provider);
  return Boolean(refreshedAt && Date.now() - refreshedAt <= runtimeCatalogRefreshTtlMs(provider));
}

export function rememberRuntimeCatalog(
  catalog: AgentChatModelCatalog,
  args: { mode: "cached" | "refresh-stale" | "force"; refreshProvider?: AgentChatModelCatalogRefreshProvider },
): AgentChatModelCatalog {
  if (args.mode === "cached" && sharedRuntimeCatalog) {
    for (const provider of REFRESH_PROVIDERS) {
      if (
        runtimeCatalogProviderIsFresh(provider)
        && catalogContainsRefreshProvider(sharedRuntimeCatalog, provider)
        && !catalogContainsRefreshProvider(catalog, provider)
      ) {
        return sharedRuntimeCatalog;
      }
    }
  }

  sharedRuntimeCatalog = catalog;
  if (args.refreshProvider && (args.mode === "force" || catalog.stale !== true)) {
    markRuntimeCatalogProviderFresh(args.refreshProvider);
    return catalog;
  }
  if (args.mode === "cached" && catalog.stale !== true) {
    for (const provider of REFRESH_PROVIDERS) {
      if (catalogContainsRefreshProvider(catalog, provider)) {
        markRuntimeCatalogProviderFresh(provider);
      }
    }
  }
  return catalog;
}

export function getRuntimeCatalogRequest(key: string): Promise<AgentChatModelCatalog | null> | undefined {
  return sharedRuntimeCatalogRequests.get(key);
}

export function setRuntimeCatalogRequest(
  key: string,
  request: Promise<AgentChatModelCatalog | null>,
): void {
  sharedRuntimeCatalogRequests.set(key, request);
}

export function clearRuntimeCatalogRequest(
  key: string,
  request: Promise<AgentChatModelCatalog | null>,
): void {
  if (sharedRuntimeCatalogRequests.get(key) === request) {
    sharedRuntimeCatalogRequests.delete(key);
  }
}
