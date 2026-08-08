import type { AgentChatModelCatalog, AgentChatModelCatalogRefreshProvider } from "../../../../shared/types";
import type { ProviderFamily } from "../../../../shared/modelRegistry";

export function refreshProviderForFamily(family: ProviderFamily): AgentChatModelCatalogRefreshProvider | null {
  if (family === "opencode") return "opencode";
  if (family === "ollama") return "ollama";
  if (family === "lmstudio") return "lmstudio";
  if (family === "cursor") return "cursor";
  if (family === "pi") return "pi";
  if (family === "factory") return "droid";
  return null;
}

const RUNTIME_CATALOG_REFRESH_TTL_MS = 30 * 60_000;
const RUNTIME_CATALOG_LOCAL_REFRESH_TTL_MS = 30_000;
const REFRESH_PROVIDERS: AgentChatModelCatalogRefreshProvider[] = [
  "opencode",
  "pi",
  "cursor",
  "droid",
  "lmstudio",
  "ollama",
];

let sharedRuntimeCatalog: AgentChatModelCatalog | null = null;
const sharedRuntimeCatalogProviderRefreshedAt = new Map<AgentChatModelCatalogRefreshProvider, number>();
// Cursor freshness is per discovery source: an SDK-scoped refresh must not
// mark the CLI surface fresh (a later Work-tab CLI picker would otherwise
// short-circuit its force refresh for the TTL and miss CLI-only changes).
const cursorSourceRefreshedAt = new Map<"sdk" | "cli", number>();
const sharedRuntimeCatalogRequests = new Map<string, Promise<AgentChatModelCatalog | null>>();

export function resetModelPickerRuntimeCatalogForTests(): void {
  sharedRuntimeCatalog = null;
  sharedRuntimeCatalogProviderRefreshedAt.clear();
  cursorSourceRefreshedAt.clear();
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
  cursorFlavor?: "sdk" | "cli",
): boolean {
  return (catalog.groups ?? []).some((group) => {
    const groupMatches = provider === "droid"
      ? group.key === "droid"
      : group.key === provider;
    if (!groupMatches) return false;
    // A cursor-flavored check must see rows the requesting surface can run:
    // an SDK-only refresh must not satisfy a CLI-surface freshness check.
    if (provider === "cursor" && cursorFlavor) {
      return (group.providers ?? []).some((entry) =>
        (entry.subsections ?? []).some((subsection) =>
          (subsection.models ?? []).some((model) => model.cursorAvailability?.[cursorFlavor] === true)));
    }
    return (group.providers ?? []).some((entry) => entry.modelCount > 0);
  });
}

function shouldMarkRefreshProviderFresh(
  catalog: AgentChatModelCatalog,
  provider: AgentChatModelCatalogRefreshProvider,
  cursorFlavor?: "sdk" | "cli",
): boolean {
  if (provider !== "cursor") return true;
  return catalogContainsRefreshProvider(catalog, provider, cursorFlavor);
}

function markRuntimeCatalogProviderFresh(
  provider: AgentChatModelCatalogRefreshProvider,
  refreshedAt = Date.now(),
  cursorFlavor?: "sdk" | "cli",
): void {
  if (provider === "cursor") {
    const sources: ("sdk" | "cli")[] = cursorFlavor ? [cursorFlavor] : ["sdk", "cli"];
    for (const source of sources) {
      // Without an explicit flavor (generic cached-reuse marking), only mark a
      // source fresh if the catalog actually carries rows it can run, so an
      // sdk-only catalog never marks the cli surface fresh.
      if (!cursorFlavor && sharedRuntimeCatalog && !catalogContainsRefreshProvider(sharedRuntimeCatalog, "cursor", source)) {
        continue;
      }
      cursorSourceRefreshedAt.set(source, refreshedAt);
    }
    return;
  }
  sharedRuntimeCatalogProviderRefreshedAt.set(provider, refreshedAt);
}

export function runtimeCatalogProviderIsFresh(
  provider: AgentChatModelCatalogRefreshProvider,
  cursorFlavor?: "sdk" | "cli",
): boolean {
  if (provider === "cursor") {
    if (!sharedRuntimeCatalog || !catalogContainsRefreshProvider(sharedRuntimeCatalog, provider, cursorFlavor)) {
      return false;
    }
    const sources: ("sdk" | "cli")[] = cursorFlavor ? [cursorFlavor] : ["sdk", "cli"];
    const ttl = runtimeCatalogRefreshTtlMs(provider);
    return sources.every((source) => {
      const at = cursorSourceRefreshedAt.get(source);
      return Boolean(at && Date.now() - at <= ttl);
    });
  }
  const refreshedAt = sharedRuntimeCatalogProviderRefreshedAt.get(provider);
  return Boolean(refreshedAt && Date.now() - refreshedAt <= runtimeCatalogRefreshTtlMs(provider));
}

export function rememberRuntimeCatalog(
  catalog: AgentChatModelCatalog,
  args: {
    mode: "cached" | "refresh-stale" | "force";
    refreshProvider?: AgentChatModelCatalogRefreshProvider;
    cursorSource?: "sdk" | "cli";
  },
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
  const cursorFlavor = args.refreshProvider === "cursor" ? args.cursorSource : undefined;
  if (
    args.refreshProvider
    && (args.mode === "force" || catalog.stale !== true)
    && shouldMarkRefreshProviderFresh(catalog, args.refreshProvider, cursorFlavor)
  ) {
    markRuntimeCatalogProviderFresh(args.refreshProvider, Date.now(), cursorFlavor);
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
