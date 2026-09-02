import type { AgentChatModelCatalog, AgentChatModelCatalogRefreshProvider } from "../../../../shared/types";
import type { ModelDescriptor, ProviderFamily } from "../../../../shared/modelRegistry";

const REFRESH_PROVIDER_BY_FAMILY: Partial<Record<ProviderFamily, AgentChatModelCatalogRefreshProvider>> = {
  opencode: "opencode",
  ollama: "ollama",
  lmstudio: "lmstudio",
  cursor: "cursor",
  pi: "pi",
  factory: "droid",
  qwen: "qwen",
  moonshot: "kimi",
  xai: "grok",
  "github-copilot": "copilot",
};

export function refreshProviderForFamily(family: ProviderFamily): AgentChatModelCatalogRefreshProvider | null {
  return REFRESH_PROVIDER_BY_FAMILY[family] ?? null;
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
  "qwen",
  "kimi",
  "grok",
  "copilot",
];

/**
 * A runtime model catalog is a MACHINE fact, not a process fact: the ollama and
 * LM Studio endpoints it enumerates, the installed `cursor-agent`, and the
 * opencode inventory all live on whichever machine served `chat.modelCatalog`.
 * A Work tab shows chats from every machine on the account at once, so every
 * entry is keyed by the binding key of the machine it describes.
 *
 * `""` remains the bucket for surfaces that have no composer machine (Settings,
 * a picker mounted without a pin). Work composers must pass the prompt-box /
 * chat machine's binding key even when that machine is also the project tab —
 * collapsing those into `""` made every "same as tab" catalog share one drawer,
 * so switching the global tab poisoned the prompt box with another machine's
 * list (or Electron's static registry).
 */
export const DEFAULT_RUNTIME_CATALOG_SCOPE = "";

type RuntimeCatalogScopeState = {
  catalog: AgentChatModelCatalog | null;
  providerRefreshedAt: Map<AgentChatModelCatalogRefreshProvider, number>;
  // Cursor freshness is per discovery source: an SDK-scoped refresh must not
  // mark the CLI surface fresh (a later Work-tab CLI picker would otherwise
  // short-circuit its force refresh for the TTL and miss CLI-only changes).
  cursorSourceRefreshedAt: Map<"sdk" | "cli", number>;
  // Descriptors parsed out of this machine's catalog. They live beside the
  // catalog rather than in a parallel registry so one cap and one eviction
  // govern both, and a dropped scope can never leave descriptors behind.
  descriptorsById: Map<string, ModelDescriptor>;
  // Identity of this bucket instance. A catalog fetch reserves the bucket and
  // remembers this value; a response that comes back after the bucket was
  // evicted or reset finds a different serial (or none) and is dropped instead
  // of resurrecting a machine the window has stopped tracking.
  serial: number;
};

// Scopes are bounded by the project bindings a window has open, so this cap is
// only a backstop against unbounded growth over a long-lived session.
const MAX_RUNTIME_CATALOG_SCOPES = 8;
const runtimeCatalogScopes = new Map<string, RuntimeCatalogScopeState>();
const sharedRuntimeCatalogRequests = new Map<string, Promise<AgentChatModelCatalog | null>>();
let nextRuntimeCatalogScopeSerial = 1;

function peekRuntimeCatalogScope(scopeKey: string): RuntimeCatalogScopeState | undefined {
  return runtimeCatalogScopes.get(scopeKey);
}

function runtimeCatalogScope(scopeKey: string): RuntimeCatalogScopeState {
  const existing = runtimeCatalogScopes.get(scopeKey);
  if (existing) return existing;
  for (const key of runtimeCatalogScopes.keys()) {
    if (runtimeCatalogScopes.size < MAX_RUNTIME_CATALOG_SCOPES) break;
    // Never evict the bound machine: it is the hottest bucket and the one every
    // unpinned surface reads, so dropping it would refetch the common case.
    if (key === DEFAULT_RUNTIME_CATALOG_SCOPE) continue;
    runtimeCatalogScopes.delete(key);
  }
  const created: RuntimeCatalogScopeState = {
    catalog: null,
    providerRefreshedAt: new Map(),
    cursorSourceRefreshedAt: new Map(),
    descriptorsById: new Map(),
    serial: nextRuntimeCatalogScopeSerial++,
  };
  runtimeCatalogScopes.set(scopeKey, created);
  return created;
}

/**
 * Claim this machine's bucket before fetching its catalog, and return the token
 * the write must present. Reserving up front is what lets a late response tell
 * "my bucket is still here" apart from "my bucket was evicted and something
 * else now owns this key".
 */
export function reserveRuntimeCatalogScope(scopeKey: string): number {
  return runtimeCatalogScope(scopeKey).serial;
}

/** This machine's parsed descriptors, created on first write. */
export function runtimeCatalogScopeDescriptors(scopeKey: string): Map<string, ModelDescriptor> {
  return runtimeCatalogScope(scopeKey).descriptorsById;
}

/** This machine's parsed descriptors, or undefined when it has reported none. */
export function peekRuntimeCatalogScopeDescriptors(
  scopeKey: string,
): Map<string, ModelDescriptor> | undefined {
  return peekRuntimeCatalogScope(scopeKey)?.descriptorsById;
}

export function clearRuntimeCatalogScopeDescriptors(): void {
  for (const scope of runtimeCatalogScopes.values()) scope.descriptorsById.clear();
}

export function resetModelPickerRuntimeCatalogForTests(): void {
  runtimeCatalogScopes.clear();
  sharedRuntimeCatalogRequests.clear();
}

export function getSharedRuntimeCatalog(
  scopeKey: string = DEFAULT_RUNTIME_CATALOG_SCOPE,
): AgentChatModelCatalog | null {
  return peekRuntimeCatalogScope(scopeKey)?.catalog ?? null;
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
  scopeKey: string,
  provider: AgentChatModelCatalogRefreshProvider,
  refreshedAt = Date.now(),
  cursorFlavor?: "sdk" | "cli",
): void {
  const scope = runtimeCatalogScope(scopeKey);
  if (provider === "cursor") {
    const sources: ("sdk" | "cli")[] = cursorFlavor ? [cursorFlavor] : ["sdk", "cli"];
    for (const source of sources) {
      // Without an explicit flavor (generic cached-reuse marking), only mark a
      // source fresh if the catalog actually carries rows it can run, so an
      // sdk-only catalog never marks the cli surface fresh.
      if (!cursorFlavor && scope.catalog && !catalogContainsRefreshProvider(scope.catalog, "cursor", source)) {
        continue;
      }
      scope.cursorSourceRefreshedAt.set(source, refreshedAt);
    }
    return;
  }
  scope.providerRefreshedAt.set(provider, refreshedAt);
}

export function runtimeCatalogProviderIsFresh(
  provider: AgentChatModelCatalogRefreshProvider,
  cursorFlavor?: "sdk" | "cli",
  scopeKey: string = DEFAULT_RUNTIME_CATALOG_SCOPE,
): boolean {
  const scope = peekRuntimeCatalogScope(scopeKey);
  if (!scope) return false;
  if (provider === "cursor") {
    if (!scope.catalog || !catalogContainsRefreshProvider(scope.catalog, provider, cursorFlavor)) {
      return false;
    }
    const sources: ("sdk" | "cli")[] = cursorFlavor ? [cursorFlavor] : ["sdk", "cli"];
    const ttl = runtimeCatalogRefreshTtlMs(provider);
    return sources.every((source) => {
      const at = scope.cursorSourceRefreshedAt.get(source);
      return Boolean(at && Date.now() - at <= ttl);
    });
  }
  const refreshedAt = scope.providerRefreshedAt.get(provider);
  return Boolean(refreshedAt && Date.now() - refreshedAt <= runtimeCatalogRefreshTtlMs(provider));
}

export function rememberRuntimeCatalog(
  catalog: AgentChatModelCatalog,
  args: {
    mode: "cached" | "refresh-stale" | "force";
    refreshProvider?: AgentChatModelCatalogRefreshProvider;
    cursorSource?: "sdk" | "cli";
    scopeKey?: string;
    /** Token from {@link reserveRuntimeCatalogScope}; omit to skip the check. */
    scopeSerial?: number;
  },
): AgentChatModelCatalog {
  const scopeKey = args.scopeKey ?? DEFAULT_RUNTIME_CATALOG_SCOPE;
  if (args.scopeSerial !== undefined
    && peekRuntimeCatalogScope(scopeKey)?.serial !== args.scopeSerial) {
    // The bucket this response was fetched for is gone (evicted or reset).
    // Hand the catalog back for immediate display, but do not recreate the
    // bucket or overwrite whatever now owns this key.
    return catalog;
  }
  const scope = runtimeCatalogScope(scopeKey);
  if (args.mode === "cached" && scope.catalog) {
    for (const provider of REFRESH_PROVIDERS) {
      if (
        runtimeCatalogProviderIsFresh(provider, undefined, scopeKey)
        && catalogContainsRefreshProvider(scope.catalog, provider)
        && !catalogContainsRefreshProvider(catalog, provider)
      ) {
        return scope.catalog;
      }
    }
  }

  scope.catalog = catalog;
  const cursorFlavor = args.refreshProvider === "cursor" ? args.cursorSource : undefined;
  // Cached catalogs can include ADE's static OpenCode rows without a live
  // probe. Only a force, or a refresh-stale the host already marked not-stale,
  // may start a live-inventory TTL. Cursor may still be marked from a cached
  // catalog that actually carries Cursor rows.
  if (
    args.refreshProvider
    && args.mode !== "cached"
    && (args.mode === "force" || catalog.stale !== true)
    && shouldMarkRefreshProviderFresh(catalog, args.refreshProvider, cursorFlavor)
  ) {
    markRuntimeCatalogProviderFresh(scopeKey, args.refreshProvider, Date.now(), cursorFlavor);
    return catalog;
  }
  if (args.mode === "cached" && catalog.stale !== true) {
    if (catalogContainsRefreshProvider(catalog, "cursor")) {
      markRuntimeCatalogProviderFresh(scopeKey, "cursor");
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
